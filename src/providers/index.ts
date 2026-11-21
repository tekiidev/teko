import { anthropic } from './anthropic.js';
import { openaiCompatible } from './openai.js';
import { google } from './google.js';

export const ADAPTERS = {
  anthropic,
  openai: openaiCompatible,
  google,
};
