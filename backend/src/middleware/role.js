module.exports = function(requiredRole) {
  return function(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (req.user.role !== requiredRole) {
      return res.status(403).json({ message: "Access denied" });
    }

    next();
  };
};
