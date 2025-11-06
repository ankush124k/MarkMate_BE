// index.js (API Server)
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

// Import our new route files
import authRoutes from './routes/auth.routes.js';
import apiRoutes from './routes/api.routes.js';

// Initialize Express App
const app = express();
const port = 3001;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Routes ---
app.get('/', (req, res) => res.send('MarkMate API is running!'));

// Use the route files
// Public routes (login/signup) are at /auth
app.use('/auth', authRoutes);

// All other protected routes are at /api
app.use('/api', apiRoutes);


// --- Start the Server ---
app.listen(port, () => {
  console.log(`🚀 API server is running at http://localhost:${port}`);
});