function validate(schema, source = 'body') {
  return (req, res, next) => {
    try {
      req[source] = schema.parse(req[source]);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { validate };
