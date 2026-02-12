import { describe, it, expect } from 'vitest';
import { parseVoiceCommand, matchQueueChoice } from '../src/services/voice-commands.js';

const BOT = 'Watson';

describe('parseVoiceCommand — new-post (guided flow trigger)', () => {
  it('parses "create a post"', () => {
    expect(parseVoiceCommand('Hey Watson, create a post', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "make a new post"', () => {
    expect(parseVoiceCommand('Hey Watson, make a new post', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "start a thread"', () => {
    expect(parseVoiceCommand('Hey Watson, start a thread', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "create a new forum topic"', () => {
    expect(parseVoiceCommand('Hey Watson, create a new forum topic', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "please create a new forum discussion"', () => {
    expect(parseVoiceCommand('Hey Watson, please create a new forum discussion', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "can you make a post"', () => {
    expect(parseVoiceCommand('Hey Watson, can you make a post', BOT)).toEqual({ type: 'new-post' });
  });

  it('parses "I want to create a post in general about stuff" (extras ignored)', () => {
    expect(parseVoiceCommand('Hey Watson, I want to create a post in general about stuff', BOT)).toEqual({ type: 'new-post' });
  });

  it('returns null without trigger phrase', () => {
    expect(parseVoiceCommand('create a post', BOT)).toBeNull();
  });

  it('returns null for unrelated commands', () => {
    expect(parseVoiceCommand('Hey Watson, tell me about forum posts', BOT)).toBeNull();
  });
});

describe('parseVoiceCommand — existing commands still work', () => {
  it('switch command', () => {
    const result = parseVoiceCommand('Hey Watson, switch to general', BOT);
    expect(result).toEqual({ type: 'switch', channel: 'general' });
  });

  it('list command', () => {
    const result = parseVoiceCommand('Hey Watson, list channels', BOT);
    expect(result).toEqual({ type: 'list' });
  });

  it('default command', () => {
    const result = parseVoiceCommand('Hey Watson, go back', BOT);
    expect(result).toEqual({ type: 'default' });
  });

  it('settings command', () => {
    const result = parseVoiceCommand('Hey Watson, settings', BOT);
    expect(result).toEqual({ type: 'settings' });
  });
});

describe('parseVoiceCommand — mode commands', () => {
  it('parses "inbox mode"', () => {
    const result = parseVoiceCommand('Hey Watson, inbox mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'queue' });
  });

  it('parses "switch to inbox mode"', () => {
    const result = parseVoiceCommand('Hey Watson, switch to inbox mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'queue' });
  });

  it('parses "queue mode" (legacy)', () => {
    const result = parseVoiceCommand('Hey Watson, queue mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'queue' });
  });

  it('parses "wait mode"', () => {
    const result = parseVoiceCommand('Hey Watson, wait mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'wait' });
  });

  it('parses "switch to wait mode"', () => {
    const result = parseVoiceCommand('Hey Watson, switch to wait mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'wait' });
  });

  it('parses "ask mode"', () => {
    const result = parseVoiceCommand('Hey Watson, ask mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'ask' });
  });

  it('parses "switch to ask mode"', () => {
    const result = parseVoiceCommand('Hey Watson, switch to ask mode', BOT);
    expect(result).toEqual({ type: 'mode', mode: 'ask' });
  });
});

describe('parseVoiceCommand — inbox check', () => {
  it('parses "what do I have"', () => {
    const result = parseVoiceCommand('Hey Watson, what do I have', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "check queue"', () => {
    const result = parseVoiceCommand('Hey Watson, check queue', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "check the queue"', () => {
    const result = parseVoiceCommand('Hey Watson, check the queue', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "what\'s waiting"', () => {
    const result = parseVoiceCommand("Hey Watson, what's waiting", BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "whats waiting" (no apostrophe)', () => {
    const result = parseVoiceCommand('Hey Watson, whats waiting', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "queue status"', () => {
    const result = parseVoiceCommand('Hey Watson, queue status', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "check inbox"', () => {
    const result = parseVoiceCommand('Hey Watson, check inbox', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "check the inbox"', () => {
    const result = parseVoiceCommand('Hey Watson, check the inbox', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "what\'s new"', () => {
    const result = parseVoiceCommand("Hey Watson, what's new", BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "whats new" (no apostrophe)', () => {
    const result = parseVoiceCommand('Hey Watson, whats new', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "inbox"', () => {
    const result = parseVoiceCommand('Hey Watson, inbox', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "inbox list"', () => {
    const result = parseVoiceCommand('Hey Watson, inbox list', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });
});

describe('parseVoiceCommand — inbox next', () => {
  it('parses "next"', () => {
    const result = parseVoiceCommand('Hey Watson, next', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "next response"', () => {
    const result = parseVoiceCommand('Hey Watson, next response', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "next one"', () => {
    const result = parseVoiceCommand('Hey Watson, next one', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "next message"', () => {
    const result = parseVoiceCommand('Hey Watson, next message', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "next channel"', () => {
    const result = parseVoiceCommand('Hey Watson, next channel', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "done"', () => {
    const result = parseVoiceCommand('Hey Watson, done', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "I\'m done"', () => {
    const result = parseVoiceCommand("Hey Watson, I'm done", BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "im done" (no apostrophe)', () => {
    const result = parseVoiceCommand('Hey Watson, im done', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "I am done"', () => {
    const result = parseVoiceCommand('Hey Watson, I am done', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "move on"', () => {
    const result = parseVoiceCommand('Hey Watson, move on', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "skip"', () => {
    const result = parseVoiceCommand('Hey Watson, skip', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "skip this"', () => {
    const result = parseVoiceCommand('Hey Watson, skip this', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "skip this one"', () => {
    const result = parseVoiceCommand('Hey Watson, skip this one', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "skip it"', () => {
    const result = parseVoiceCommand('Hey Watson, skip it', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });
});

describe('parseVoiceCommand — Hello Watson trigger', () => {
  it('parses "Hello Watson, inbox"', () => {
    const result = parseVoiceCommand('Hello Watson, inbox', BOT);
    expect(result).toEqual({ type: 'inbox-check' });
  });

  it('parses "Hello Watson, switch to health"', () => {
    const result = parseVoiceCommand('Hello Watson, switch to health', BOT);
    expect(result).toEqual({ type: 'switch', channel: 'health' });
  });

  it('parses "Hello Watson, done"', () => {
    const result = parseVoiceCommand('Hello Watson, done', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });

  it('parses "Hello Watson, skip"', () => {
    const result = parseVoiceCommand('Hello Watson, skip', BOT);
    expect(result).toEqual({ type: 'inbox-next' });
  });
});

describe('parseVoiceCommand — voice status', () => {
  it('parses "voice status"', () => {
    const result = parseVoiceCommand('Hey Watson, voice status', BOT);
    expect(result).toEqual({ type: 'voice-status' });
  });

  it('parses "status"', () => {
    const result = parseVoiceCommand('Hey Watson, status', BOT);
    expect(result).toEqual({ type: 'voice-status' });
  });

  it('parses "Hello Watson, voice status"', () => {
    const result = parseVoiceCommand('Hello Watson, voice status', BOT);
    expect(result).toEqual({ type: 'voice-status' });
  });
});

describe('matchQueueChoice', () => {
  it('returns "queue" for "inbox"', () => {
    expect(matchQueueChoice('inbox')).toBe('queue');
  });

  it('returns "queue" for "in box"', () => {
    expect(matchQueueChoice('in box')).toBe('queue');
  });

  it('returns "queue" for "Inbox." (with punctuation)', () => {
    expect(matchQueueChoice('Inbox.')).toBe('queue');
  });

  it('returns "queue" for "yes"', () => {
    expect(matchQueueChoice('yes')).toBe('queue');
  });

  it('returns "queue" for "queue"', () => {
    expect(matchQueueChoice('queue')).toBe('queue');
  });

  it('returns "queue" for "cue" (Whisper misrecognition)', () => {
    expect(matchQueueChoice('cue')).toBe('queue');
  });

  it('returns "wait" for "wait"', () => {
    expect(matchQueueChoice('wait')).toBe('wait');
  });

  it('returns "wait" for "weight" (Whisper misrecognition)', () => {
    expect(matchQueueChoice('weight')).toBe('wait');
  });

  it('returns "wait" for "no"', () => {
    expect(matchQueueChoice('no')).toBe('wait');
  });

  it('matches "wait" as substring', () => {
    expect(matchQueueChoice("let's wait")).toBe('wait');
  });

  it('returns "cancel" for "cancel"', () => {
    expect(matchQueueChoice('cancel')).toBe('cancel');
  });

  it('returns "cancel" for "nevermind"', () => {
    expect(matchQueueChoice('nevermind')).toBe('cancel');
  });

  it('returns "cancel" for "never mind"', () => {
    expect(matchQueueChoice('never mind')).toBe('cancel');
  });

  it('returns "cancel" for "forget it"', () => {
    expect(matchQueueChoice('forget it')).toBe('cancel');
  });

  it('returns "cancel" for "nothing"', () => {
    expect(matchQueueChoice('nothing')).toBe('cancel');
  });

  it('returns "cancel" for "ignore that"', () => {
    expect(matchQueueChoice('ignore that')).toBe('cancel');
  });

  it('returns null for unrecognized input', () => {
    expect(matchQueueChoice('hello')).toBeNull();
  });

  it('handles leading/trailing whitespace', () => {
    expect(matchQueueChoice('  inbox  ')).toBe('queue');
    expect(matchQueueChoice('  wait  ')).toBe('wait');
  });

  it('is case-insensitive', () => {
    expect(matchQueueChoice('INBOX')).toBe('queue');
    expect(matchQueueChoice('Wait')).toBe('wait');
  });

  it('strips trailing punctuation', () => {
    expect(matchQueueChoice('inbox.')).toBe('queue');
    expect(matchQueueChoice('wait!')).toBe('wait');
  });
});
