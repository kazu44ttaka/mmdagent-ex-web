/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Modified from MMDAgent-EX:
 *   Plugin_Remote/Julius_Thread.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/*
 * Julius for the browser: phoneme recognition on pushed audio, as
 * MMDAgent-EX Plugin_Remote (Julius_Thread.cpp) runs it for lip sync.
 *
 * The A/D-in callbacks read from a buffer filled by jw_feed() instead of a
 * microphone. Each 1st-pass interim result reports its last phoneme (the
 * same word Julius_Thread::proc picks), and the end of a recognition reports
 * NULL, through Module.onPhone(phone, samplePosition).
 *
 */

#include <julius/juliuslib.h>
#include <emscripten.h>
#include <string.h>
#include <stdlib.h>

EM_JS(void, jw_on_phone, (const char *phone, double position), {
  if (Module.onPhone) Module.onPhone(phone ? UTF8ToString(phone) : null, position);
});

EM_JS(void, jw_on_log, (const char *text), {
  if (Module.onLog) Module.onLog(UTF8ToString(text));
});

#define BUFFER_SAMPLES (16000 * 60) /* AUDIO_PLAY_BUFFER_SIZE_IN_SEC = 60 */

static Recog *recog = NULL;
static Jconf *jconf = NULL;
static SP16 *buffer = NULL;
static int stored = 0;
static int want_segment = 0;
static int streaming = 0;
static int running = 0;
static double delivered = 0; /* samples handed to Julius so far */

/* "-input mic" needs these; audio really comes through the callbacks below */
boolean adin_mic_standby(int freq, void *arg, void *data) { return TRUE; }
boolean adin_mic_begin(char *pathname, void *data) { return TRUE; }
boolean adin_mic_end(void *data) { return TRUE; }
int adin_mic_read(SP16 *buf, int sampnum, void *data) { return 0; }
boolean adin_mic_pause(void *data) { return TRUE; }
boolean adin_mic_terminate(void *data) { return TRUE; }
boolean adin_mic_resume(void *data) { return TRUE; }
char *adin_mic_input_name(void *data) { return "browser"; }

/* A/D-in callbacks (AudioProcess in Julius_Thread.cpp) */
static boolean cb_standby(int freq, void *dummy, void *user_data) { return TRUE; }
static boolean cb_begin(char *arg, void *user_data) { return TRUE; }
static boolean cb_end(void *user_data) { return TRUE; }
static boolean cb_pause(void *user_data) { return TRUE; }
static boolean cb_terminate(void *user_data) { return TRUE; }
static boolean cb_resume(void *user_data) { return TRUE; }
static char *cb_input_name(void *user_data) { return "browser"; }

static int cb_read(SP16 *buf, int sampnum, void *user_data)
{
   int n;
   ADIn *adin = recog->adin;
   /* silence segmentation only in streaming mode (SNDSTRM) */
   adin->adin_cut_on = adin->silence_cut_default = streaming ? TRUE : FALSE;
   if (stored == 0) {
      if (want_segment) {
         want_segment = 0;
         return -3; /* segment here */
      }
      emscripten_sleep(15); /* Pa_Sleep(15) */
      return 0;
   }
   n = stored < sampnum ? stored : sampnum;
   memcpy(buf, buffer, n * sizeof(SP16));
   if (stored > n) memmove(buffer, buffer + n, (stored - n) * sizeof(SP16));
   stored -= n;
   delivered += n;
   return n;
}

/* Julius_Thread::proc: the last word of the 1st-pass interim result */
static void cb_interim(Recog *r, void *data)
{
   RecogProcess *process;
   Sentence *sentence;
   const char *last = NULL;
   for (process = r->process_list; process; process = process->next) {
      if (!process->live || !process->have_interim) continue;
      sentence = &(process->result.pass1);
      if (sentence->word_num >= 1)
         last = process->lm->winfo->woutput[sentence->word[sentence->word_num - 1]];
   }
   if (last) jw_on_phone(last, delivered);
}

/* Julius_Thread::procEnd */
static void cb_end_recog(Recog *r, void *data)
{
   jw_on_phone(NULL, delivered);
}

static void log_output(char *text) { jw_on_log(text); }

/* Load the jconf (paths inside it are relative to it) and get ready. */
EMSCRIPTEN_KEEPALIVE
int jw_init(const char *jconf_path)
{
   ADIn *adin;
   jlog_set_output(stderr);
   jconf = j_config_load_file_new((char *)jconf_path);
   if (jconf == NULL) return -1;
   recog = j_create_instance_from_jconf(jconf);
   if (recog == NULL) return -2;
   callback_add(recog, CALLBACK_RESULT_PASS1_INTERIM, cb_interim, NULL);
   callback_add(recog, CALLBACK_EVENT_RECOGNITION_END, cb_end_recog, NULL);
   buffer = (SP16 *)malloc(sizeof(SP16) * BUFFER_SAMPLES);
   adin = recog->adin;
   adin->user_data = NULL;
   adin->ad_standby = cb_standby;
   adin->ad_begin = cb_begin;
   adin->ad_end = cb_end;
   adin->ad_resume = cb_resume;
   adin->ad_pause = cb_pause;
   adin->ad_terminate = cb_terminate;
   adin->ad_read = cb_read;
   adin->ad_input_name = cb_input_name;
   adin->silence_cut_default = TRUE;
   adin->enable_thread = FALSE;
   adin->ds = NULL;
   adin->down_sample = FALSE;
   if (adin_standby(adin, recog->jconf->input.sfreq, NULL) == FALSE) return -3;
   if (adin_setup_param(adin, recog->jconf) == FALSE) return -4;
   adin->input_side_segment = FALSE;
   if (j_open_stream(recog, NULL) != 0) return -5;
   return 0;
}

/* Run recognition forever; yields while waiting for audio (Asyncify). */
EMSCRIPTEN_KEEPALIVE
void jw_run(void)
{
   if (recog == NULL || running) return;
   running = 1;
   for (;;) {
      if (j_recognize_stream(recog) == -1) break;
   }
   running = 0;
}

/* Append 16 kHz mono samples (AudioProcess::appendAudioData). */
EMSCRIPTEN_KEEPALIVE
void jw_feed(const SP16 *samples, int n)
{
   if (buffer == NULL || stored + n >= BUFFER_SAMPLES) return;
   memcpy(buffer + stored, samples, n * sizeof(SP16));
   stored += n;
}

/* SNDSTRM (1) / SNDFILE (0) */
EMSCRIPTEN_KEEPALIVE
void jw_set_streaming(int flag) { streaming = flag; }

/* SNDBRKS: end the current segment once the buffer is consumed */
EMSCRIPTEN_KEEPALIVE
void jw_segment(void) { want_segment = 1; }

/* Drop buffered audio. */
EMSCRIPTEN_KEEPALIVE
void jw_clear(void) { stored = 0; }

/* Samples handed to Julius so far (for timing). */
EMSCRIPTEN_KEEPALIVE
double jw_delivered(void) { return delivered; }
