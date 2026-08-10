import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { rateLimit } from "express-rate-limit";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Trust reverse proxy (Render, Vercel, etc.) to get correct client IPs for rate-limiting
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// CORS configuration - restrict origins if ALLOWED_ORIGINS is set
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
const allowedOrigins = allowedOriginsEnv
  ? allowedOriginsEnv.split(",").map((o) => o.trim())
  : [];

if (allowedOrigins.length > 0) {
  logger.info({ allowedOrigins }, "Restricting CORS to allowed origins");
} else {
  logger.warn("CORS allowed origins not specified. Defaulting to allow-all (development mode fallback).");
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or server-to-server)
      if (!origin) return callback(null, true);

      if (
        process.env.NODE_ENV !== "production" ||
        allowedOrigins.includes(origin) ||
        allowedOrigins.length === 0
      ) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- API Protection Middlewares ---

// General rate limiter: max 100 requests per 15 minutes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// Strict rate limiter for extraction: max 10 requests per 15 minutes
const extractionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Rate limit exceeded for policy extraction. Please try again after 15 minutes." },
});

// Client token verification middleware
function checkClientToken(req: Request, res: Response, next: NextFunction): void {
  const serverToken = process.env.API_CLIENT_TOKEN;
  if (!serverToken) {
    // If no token is configured on the server, skip validation
    return next();
  }

  const clientToken = req.headers["x-api-client-token"];
  if (clientToken !== serverToken) {
    logger.warn({ ip: req.ip }, "Unauthorized access attempt with invalid/missing client token");
    res.status(401).json({ error: "Unauthorized: Invalid or missing client token" });
    return;
  }

  next();
}

// Apply general rate limiting to all requests
app.use(generalLimiter);

// Apply strict rate limiting and client token check to the policy extraction endpoint
app.use("/api/extract-policies", extractionLimiter, checkClientToken);

app.use("/api", router);

export default app;
