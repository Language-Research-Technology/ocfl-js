// Note: So we can return a similar error to node:fs
export class SystemError extends Error {
  code: string;

  errno: number;

  constructor(message: string, code: string, errno: number) {
    super(message);
    this.code = code;
    this.errno = errno;
  }
}
