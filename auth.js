import jwt from 'jsonwebtoken';

// This is the same secret you used in index.js
const JWT_SECRET = 'YOUR-SUPER-SECRET-KEY-CHANGE-THIS';

// This is the middleware function
export const authMiddleware = (req, res, next) => {
  // 1. Get the token from the request header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided, authorization denied.' });
  }

  const token = authHeader.split(' ')[1]; // "Bearer TOKEN" -> "TOKEN"

  // 2. Verify the token
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // 3. If valid, add user info to the request object
    // Now, every protected route will know *who* the user is
    req.user = decoded; 

    // 4. Call 'next()' to pass the request to the actual route
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token is not valid.' });
  }
};