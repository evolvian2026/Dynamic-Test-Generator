import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import config from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import authRoutes from './routes/auth.js';
import questionRoutes from './routes/questions.js';
import testRoutes from './routes/tests.js';
import templateRoutes from './routes/templates.js';
import exportRoutes from './routes/exports.js';
import analyticsRoutes from './routes/analytics.js';
import userRoutes from './routes/users.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The SPA is served from the same origin and uses no inline scripts.
      contentSecurityPolicy: config.isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:'],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  if (config.env !== 'test') app.use(morgan(config.isProduction ? 'combined' : 'dev'));

  // Broad safety net; the login route adds its own stricter limit.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', env: config.env, time: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/questions', questionRoutes);
  app.use('/api/tests', testRoutes);
  app.use('/api/templates', templateRoutes);
  app.use('/api/exports', exportRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/users', userRoutes);

  app.use('/api', notFoundHandler);

  // Serve the built SPA when it exists, with client-side routing fallback.
  if (fs.existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist, { maxAge: config.isProduction ? '1y' : 0, index: false }));
    app.get(/^(?!\/api).*/, (req, res) => {
      res.sendFile(path.join(config.clientDist, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res.status(200).type('text/plain').send(
        'Dynamic Test Generator API is running.\n' +
        'The web client has not been built yet — run `npm run build`, or `npm run dev` for the dev server.\n',
      );
    });
  }

  app.use(errorHandler);
  return app;
}

export default createApp;
