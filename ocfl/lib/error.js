class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

class NotImplementedError extends Error {
  constructor(methodName) {
    let msg = methodName ? 'Method ' + methodName + ' has not been implemented' : '';
    super(msg);
    this.name = 'NotImplementedError';
  }
}

module.exports = {
  ValidationError,
  NotImplementedError
};