class NotImplementedError extends Error {
  constructor(methodName) {
    let msg = methodName ? 'Method ' + methodName + ' has not been implemented' : '';
    super(msg);
    this.name = 'NotImplementedError';
  }
}

module.exports = {
  NotImplementedError
};
