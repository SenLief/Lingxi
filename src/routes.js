import express from 'express';
import { handleChatCompletions } from './services/chatCompletions.js';

export const router = express.Router();

router.post('/chat/completions', handleChatCompletions); 