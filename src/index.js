import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { router as apiRouter } from './routes.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/', (req, res) => {
  res.json({ ok: true, name: 'lingxi-openai-proxy' });
});

app.use('/v1', apiRouter);

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`Lingxi OpenAI proxy listening on http://localhost:${port}`);
}); 