// Legacy browser/API authentication. Do not add TAB_BACKEND_TOKEN here: this
// middleware is still called from browser code and must migrate to verified
// MSAL identity and roles separately.
const authMiddleware = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  if (token !== 'your-secret-token') {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  next();
};

module.exports = authMiddleware;
