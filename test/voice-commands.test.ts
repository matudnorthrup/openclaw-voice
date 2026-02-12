import { describe, it, expect } from 'vitest';
import { parseVoiceCommand, matchQueueChoice } from '../src/services/voice-commands.js';

const BOT = 'Watson';

describe('parseVoiceCommand — new-post', () => {
  it('parses "make a new post in X about Y"', () => {
    const result = parseVoiceCommand('Hey Watson, make a new post in 3D printing about multi-color printing', BOT);
    expect(result).toEqual({ type: 'new-post', forum: '3d printing', title: 'multi-color printing' });
  });

  it('parses "create a post in X about Y"', () => {
    const result = parseVoiceCommand('Hey Watson, create a post in general about weekend plans', BOT);
    expect(result).toEqual({ type: 'new-post', forum: 'general', title: 'weekend plans' });
  });

  it('parses "start a thread in X called Y"', () => {
    const result = parseVoiceCommand('Hey Watson, start a thread in dev logs called deployment checklist', BOT);
    expect(result).toEqual({ type: 'new-post', forum: 'dev logs', title: 'deployment checklist' });
  });

  it('parses "create a new thread in X titled Y"', () => {
    const result = parseVoiceCommand('Hey Watson, create a new thread in project ideas titled AI assistant', BOT);
    expect(result).toEqual({ type: 'new-post', forum: 'project ideas', title: 'ai assistant' });
  });

  it('parses with "the" before forum name', () => {
    const result = parseVoiceCommand('Hey Watson, make a post in the health forum about sleep tracking', BOT);
    expect(result).toEqual({ type: 'new-post', forum: 'health forum', title: 'sleep tracking' });
  });

  it('parses with "my" before forum name', () => {
    const result = parseVoiceCommand('Hey Watson, create a post in my journal called morning routine', BOT);
    expect(result).toEqual({ type: 'new-post', forum: 'journal', title: 'morning routine' });
  });

  it('parses without "a" or "new"', () => {
    const result = parseVoiceCommand('Hey Watson, make post in cooking about best pasta recipe', BOT);
    expect(result).toEqual({ type: 'new-post', forum: 'cooking', title: 'best pasta recipe' });
  });

  it('parses without "new" but with "a"', () => {
    const result = parseVoiceCommand('Hey Watson, create a thread in music about favorite albums', BOT);
    expect(result).toEqual({ type: 'new-post', forum: 'music', title: 'favorite albums' });
  });

  it('parses "create a new forum post in X called Y"', () => {
    const result = parseVoiceCommand('Hey Watson, create a new forum post in my open cloth forum called testing switching', BOT);
    expect(result).toEqual({ type: 'new-post', forum: 'open cloth forum', title: 'testing switching' });
  });

  it('captures extended description after title', () => {
    const result = parseVoiceCommand(
      'Hey Watson, make a new post in 3D printing about multi-color printing. I have been experimenting with filament swapping and wanted to discuss approaches',
      BOT,
    );
    expect(result).toEqual({
      type: 'new-post',
      forum: '3d printing',
      title: 'multi-color printing. i have been experimenting with filament swapping and wanted to discuss approaches',
    });
  });

  it('forum capture is non-greedy (stops at delimiter)', () => {
    const result = parseVoiceCommand('Hey Watson, make a new post in stuff about things about the topic', BOT);
    expect(result).toEqual({ type: 'new-post', forum: 'stuff', title: 'things about the topic' });
  });

  it('trims whitespace from forum and title', () => {
    const result = parseVoiceCommand('Hey Watson, make a new post in  testing  about  some title ', BOT);
    expect(result).toEqual({ type: 'new-post', forum: 'testing', title: 'some title' });
  });

  it('returns null when no delimiter (about/called/titled) is present', () => {
    const result = parseVoiceCommand('Hey Watson, make a new post in general', BOT);
    expect(result).toBeNull();
  });

  it('returns null for non-matching commands', () => {
    const result = parseVoiceCommand('Hey Watson, tell me about forum posts', BOT);
    expect(result).toBeNull();
  });

  it('returns null without trigger phrase', () => {
    const result = parseVoiceCommand('make a new post in general about stuff', BOT);
    expect(result).toBeNull();
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
