import { describe, it, expect } from 'vitest';
import { parseVoiceCommand } from '../src/services/voice-commands.js';

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
