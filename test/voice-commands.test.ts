import { describe, it, expect } from 'vitest';
import { parseVoiceCommand, matchesWakeWord, matchQueueChoice, matchSwitchChoice } from '../src/services/voice-commands.js';

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

describe('parseVoiceCommand — dispatch command', () => {
  it('parses dispatch with plain body', () => {
    const result = parseVoiceCommand(
      'Hey Watson, dispatch to health channel please start my morning routine',
      BOT,
    );
    expect(result).toEqual({
      type: 'dispatch',
      body: 'health channel please start my morning routine',
    });
  });

  it('parses dispatch with "this message" phrase', () => {
    const result = parseVoiceCommand(
      'Hello Watson, dispatch this message to planning: draft my evening checklist',
      BOT,
    );
    expect(result).toEqual({
      type: 'dispatch',
      body: 'planning: draft my evening checklist',
    });
  });

  it('parses dispatch with "this in my" variant', () => {
    const result = parseVoiceCommand(
      'Hello Watson, dispatch this in my walmart channel please add abuela flour tortillas',
      BOT,
    );
    expect(result).toEqual({
      type: 'dispatch',
      body: 'my walmart channel please add abuela flour tortillas',
    });
  });

  it('parses dispatch with polite prefix', () => {
    const result = parseVoiceCommand(
      'Hello Watson, please dispatch this to my walmart channel add two 36 packs of eggs',
      BOT,
    );
    expect(result).toEqual({
      type: 'dispatch',
      body: 'my walmart channel add two 36 packs of eggs',
    });
  });

  it('does not parse dispatch without wake trigger', () => {
    const result = parseVoiceCommand('dispatch to planning finish my notes', BOT);
    expect(result).toBeNull();
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

  it('parses "back to inbox, inbox list"', () => {
    const result = parseVoiceCommand('Hey Watson, back to inbox, inbox list', BOT);
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

describe('parseVoiceCommand — inbox clear', () => {
  it('parses "clear inbox"', () => {
    const result = parseVoiceCommand('Hey Watson, clear inbox', BOT);
    expect(result).toEqual({ type: 'inbox-clear' });
  });

  it('parses "clear the inbox"', () => {
    const result = parseVoiceCommand('Hey Watson, clear the inbox', BOT);
    expect(result).toEqual({ type: 'inbox-clear' });
  });

  it('parses "mark inbox read"', () => {
    const result = parseVoiceCommand('Hey Watson, mark inbox read', BOT);
    expect(result).toEqual({ type: 'inbox-clear' });
  });
});

describe('parseVoiceCommand — read last message', () => {
  it('parses "read the last message"', () => {
    const result = parseVoiceCommand('Hey Watson, read the last message', BOT);
    expect(result).toEqual({ type: 'read-last-message' });
  });

  it('parses "last message"', () => {
    const result = parseVoiceCommand('Hello Watson, last message', BOT);
    expect(result).toEqual({ type: 'read-last-message' });
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

describe('parseVoiceCommand — wake check', () => {
  it('parses "Hello Watson" with no trailing command', () => {
    const result = parseVoiceCommand('Hello Watson', BOT);
    expect(result).toEqual({ type: 'wake-check' });
  });

  it('parses "Hey Watson," with no trailing command', () => {
    const result = parseVoiceCommand('Hey Watson,', BOT);
    expect(result).toEqual({ type: 'wake-check' });
  });

  it('parses "Watson." with no trailing command', () => {
    const result = parseVoiceCommand('Watson.', BOT);
    expect(result).toEqual({ type: 'wake-check' });
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

describe('parseVoiceCommand — silent wait', () => {
  it('parses "Hello Watson, silent"', () => {
    const result = parseVoiceCommand('Hello Watson, silent', BOT);
    expect(result).toEqual({ type: 'silent-wait' });
  });

  it('parses "Hey Watson, wait quietly"', () => {
    const result = parseVoiceCommand('Hey Watson, wait quietly', BOT);
    expect(result).toEqual({ type: 'silent-wait' });
  });
});

describe('matchQueueChoice', () => {
  it('returns "queue" for "inbox"', () => {
    expect(matchQueueChoice('inbox')).toBe('queue');
  });

  it('returns "queue" for "send to inbox"', () => {
    expect(matchQueueChoice('send to inbox')).toBe('queue');
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

  it('returns "silent" for "silent"', () => {
    expect(matchQueueChoice('silent')).toBe('silent');
  });

  it('returns "silent" for "silently"', () => {
    expect(matchQueueChoice('silently')).toBe('silent');
  });

  it('returns "silent" for "quiet"', () => {
    expect(matchQueueChoice('quiet')).toBe('silent');
  });

  it('returns "silent" for "quietly"', () => {
    expect(matchQueueChoice('quietly')).toBe('silent');
  });

  it('returns "silent" for "shh"', () => {
    expect(matchQueueChoice('shh')).toBe('silent');
  });

  it('returns "wait" for "wait"', () => {
    expect(matchQueueChoice('wait')).toBe('wait');
  });

  it('returns "wait" for "wait here"', () => {
    expect(matchQueueChoice('wait here')).toBe('wait');
  });

  it('returns "wait" for "weight" (Whisper misrecognition)', () => {
    expect(matchQueueChoice('weight')).toBe('wait');
  });

  it('returns "wait" for "wheat" (Whisper misrecognition)', () => {
    expect(matchQueueChoice('wheat')).toBe('wait');
  });

  it('returns "wait" for phrase with "wheat"', () => {
    expect(matchQueueChoice('let us do wheat')).toBe('wait');
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

  it('returns null when both queue and wait words appear', () => {
    expect(matchQueueChoice('inbox or wait')).toBeNull();
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

describe('matchSwitchChoice', () => {
  it('returns "read" for "read"', () => {
    expect(matchSwitchChoice('read')).toBe('read');
  });

  it('returns "read" for "last message"', () => {
    expect(matchSwitchChoice('last message')).toBe('read');
  });

  it('returns "read" for "read it"', () => {
    expect(matchSwitchChoice('read it')).toBe('read');
  });

  it('returns "read" for "yes"', () => {
    expect(matchSwitchChoice('yes')).toBe('read');
  });

  it('returns "read" for "yeah"', () => {
    expect(matchSwitchChoice('yeah')).toBe('read');
  });

  it('returns "read" for "go ahead"', () => {
    expect(matchSwitchChoice('go ahead')).toBe('read');
  });

  it('returns "read" for phrase with read token', () => {
    expect(matchSwitchChoice('could you read that')).toBe('read');
  });

  it('returns "read" for "reed" (Whisper misrecognition)', () => {
    expect(matchSwitchChoice('reed')).toBe('read');
  });

  it('returns "read" for "red" (Whisper misrecognition)', () => {
    expect(matchSwitchChoice('red')).toBe('read');
  });

  it('returns "read" for "read back"', () => {
    expect(matchSwitchChoice('read back')).toBe('read');
  });

  it('returns "prompt" for "prompt"', () => {
    expect(matchSwitchChoice('prompt')).toBe('prompt');
  });

  it('returns "prompt" for "new prompt"', () => {
    expect(matchSwitchChoice('new prompt')).toBe('prompt');
  });

  it('returns "prompt" for "new message"', () => {
    expect(matchSwitchChoice('new message')).toBe('prompt');
  });

  it('returns "prompt" for "skip"', () => {
    expect(matchSwitchChoice('skip')).toBe('prompt');
  });

  it('returns "prompt" for "no"', () => {
    expect(matchSwitchChoice('no')).toBe('prompt');
  });

  it('returns "prompt" for "nope"', () => {
    expect(matchSwitchChoice('nope')).toBe('prompt');
  });

  it('returns "prompt" for "just prompt"', () => {
    expect(matchSwitchChoice('just prompt')).toBe('prompt');
  });

  it('returns "prompt" for "skip it"', () => {
    expect(matchSwitchChoice('skip it')).toBe('prompt');
  });

  it('returns "prompt" for phrase with prompt token', () => {
    expect(matchSwitchChoice('lets do prompt')).toBe('prompt');
  });

  it('returns "prompt" for "romped" (Whisper misrecognition)', () => {
    expect(matchSwitchChoice('romped')).toBe('prompt');
  });

  it('returns "prompt" for "ramped" (Whisper misrecognition)', () => {
    expect(matchSwitchChoice('ramped')).toBe('prompt');
  });

  it('returns "cancel" for "cancel"', () => {
    expect(matchSwitchChoice('cancel')).toBe('cancel');
  });

  it('returns "cancel" for "nevermind"', () => {
    expect(matchSwitchChoice('nevermind')).toBe('cancel');
  });

  it('returns null for unrecognized input', () => {
    expect(matchSwitchChoice('hello')).toBeNull();
  });

  it('handles trailing punctuation', () => {
    expect(matchSwitchChoice('read.')).toBe('read');
    expect(matchSwitchChoice('prompt!')).toBe('prompt');
  });

  it('is case-insensitive', () => {
    expect(matchSwitchChoice('Read')).toBe('read');
    expect(matchSwitchChoice('PROMPT')).toBe('prompt');
  });

  it('handles whitespace', () => {
    expect(matchSwitchChoice('  read  ')).toBe('read');
    expect(matchSwitchChoice('  prompt  ')).toBe('prompt');
  });
});

describe('matchesWakeWord', () => {
  it('matches "Watson, what time is it"', () => {
    expect(matchesWakeWord('Watson, what time is it', BOT)).toBe(true);
  });

  it('matches "Hey Watson, do something"', () => {
    expect(matchesWakeWord('Hey Watson, do something', BOT)).toBe(true);
  });

  it('matches "Hello Watson, do something"', () => {
    expect(matchesWakeWord('Hello Watson, do something', BOT)).toBe(true);
  });

  it('matches case-insensitively: "watson help"', () => {
    expect(matchesWakeWord('watson help', BOT)).toBe(true);
  });

  it('matches "hey watson" with comma: "Hey Watson, status"', () => {
    expect(matchesWakeWord('Hey Watson, status', BOT)).toBe(true);
  });

  it('matches bare "Watson" with no trailing content', () => {
    expect(matchesWakeWord('Watson', BOT)).toBe(true);
  });

  it('does not match random speech', () => {
    expect(matchesWakeWord("what's on the agenda today", BOT)).toBe(false);
  });

  it('does not match "hey" alone', () => {
    expect(matchesWakeWord('hey', BOT)).toBe(false);
  });

  it('does not match partial bot name in middle of word', () => {
    expect(matchesWakeWord('Watsonia is a suburb', BOT)).toBe(false);
  });

  it('handles leading whitespace', () => {
    expect(matchesWakeWord('  Watson, hello', BOT)).toBe(true);
  });
});

describe('parseVoiceCommand — pause', () => {
  const cases = [
    'pause', 'stop', 'stop talking', 'be quiet', 'shut up',
    'shush', 'hush', 'quiet', 'silence', 'enough',
  ];

  for (const phrase of cases) {
    it(`parses "${phrase}"`, () => {
      expect(parseVoiceCommand(`Hey Watson, ${phrase}`, BOT)).toEqual({ type: 'pause' });
    });
  }

  it('parses with "Hello Watson" trigger', () => {
    expect(parseVoiceCommand('Hello Watson, pause', BOT)).toEqual({ type: 'pause' });
  });

  it('parses with trailing punctuation', () => {
    expect(parseVoiceCommand('Hey Watson, stop!', BOT)).toEqual({ type: 'pause' });
  });

  it('returns null for "stop the music" (not an exact match)', () => {
    expect(parseVoiceCommand('Hey Watson, stop the music', BOT)).toBeNull();
  });

  it('returns null without wake word', () => {
    expect(parseVoiceCommand('pause', BOT)).toBeNull();
  });
});

describe('parseVoiceCommand — replay', () => {
  const cases = [
    'replay', 're-read', 'reread', 'read that again', 'say that again',
    'repeat', 'repeat that', 'what did you say', 'come again',
  ];

  for (const phrase of cases) {
    it(`parses "${phrase}"`, () => {
      expect(parseVoiceCommand(`Hey Watson, ${phrase}`, BOT)).toEqual({ type: 'replay' });
    });
  }

  it('parses with "Hello Watson" trigger', () => {
    expect(parseVoiceCommand('Hello Watson, replay', BOT)).toEqual({ type: 'replay' });
  });

  it('parses with trailing punctuation', () => {
    expect(parseVoiceCommand('Hey Watson, repeat that.', BOT)).toEqual({ type: 'replay' });
  });

  it('returns null without wake word', () => {
    expect(parseVoiceCommand('replay', BOT)).toBeNull();
  });
});

describe('parseVoiceCommand — gated-mode', () => {
  it('parses "gated mode"', () => {
    expect(parseVoiceCommand('Hey Watson, gated mode', BOT)).toEqual({ type: 'gated-mode', enabled: true });
  });

  it('parses "gate on"', () => {
    expect(parseVoiceCommand('Watson, gate on', BOT)).toEqual({ type: 'gated-mode', enabled: true });
  });

  it('parses "open mode"', () => {
    expect(parseVoiceCommand('Hey Watson, open mode', BOT)).toEqual({ type: 'gated-mode', enabled: false });
  });

  it('parses "gate off"', () => {
    expect(parseVoiceCommand('Watson, gate off', BOT)).toEqual({ type: 'gated-mode', enabled: false });
  });

  it('parses "ungated mode"', () => {
    expect(parseVoiceCommand('Hello Watson, ungated mode', BOT)).toEqual({ type: 'gated-mode', enabled: false });
  });
});

describe('parseVoiceCommand — earcon tour', () => {
  it('parses "earcon tour"', () => {
    expect(parseVoiceCommand('Hey Watson, earcon tour', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('parses "voice tour"', () => {
    expect(parseVoiceCommand('Hey Watson, voice tour', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('parses "sound demo"', () => {
    expect(parseVoiceCommand('Watson, sound demo', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('parses "audio check"', () => {
    expect(parseVoiceCommand('Watson, audio check', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('parses "test earcons"', () => {
    expect(parseVoiceCommand('Hello Watson, test earcons', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('parses common misrecognition "ear contour"', () => {
    expect(parseVoiceCommand('Hello Watson, ear contour', BOT)).toEqual({ type: 'earcon-tour' });
  });

  it('returns null without wake word', () => {
    expect(parseVoiceCommand('earcon tour', BOT)).toBeNull();
  });
});
