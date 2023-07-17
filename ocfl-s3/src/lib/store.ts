import stream from 'stream';

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import { OcflStore } from '@ocfl/ocfl';

import { SystemError } from './error.js';

const s3 = new S3Client({});

export type OcflS3StoreConfig = {
  bucketName: string,
  s3: S3Client,
}

/**
 * OCFL Object backed by S3 storage
 */
export class OcflS3Store extends OcflStore {
  static override instances = new Map();

  bucketName: string;

  s3: S3Client;

  /**
   * Create a new backend S3 store
   */
  constructor(config: OcflS3StoreConfig) {
    super(config);

    if (!config.bucketName) {
      throw new Error('bucket is required');
    }

    this.bucketName = config.bucketName;
    this.s3 = config.s3 || s3;
  }

  override async exists(filePath: string) {
    const command = new HeadObjectCommand({
      Bucket: this.bucketName,
      Key: filePath.replace(/^\//, ''),
    });

    try {
      await this.s3.send(command);
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFound') {
        return false;
      }

      throw error;
    }
  }

  override async createReadStream(filePath: string, _options: object) { // eslint-disable-line @typescript-eslint/no-unused-vars
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: filePath.replace(/^\//, ''),
    });

    try {
      const object = await this.s3.send(command);

      return object.Body as stream.Readable;
    } catch (error) {
      if (error instanceof Error && ['NoSuchKey', 'NotFound'].includes(error.name)) {
        throw new SystemError(`Object not found: ${filePath}`, 'ENOENT', -34);
      }
      throw error;
    }
  }

  override async createWriteStream(filePath: string, _options: object) { // eslint-disable-line @typescript-eslint/no-unused-vars
    const ws = new stream.PassThrough();

    const command = {
      client: this.s3,
      params: {
        Bucket: this.bucketName,
        Key: filePath.replace(/^\//, ''),
        Body: ws,
      },
    };

    const upload = new Upload(command);

    const promise = upload.done();

    return { ws, promise };
  }

  // async opendir(filePath, options) {
  //   console.opendir('ERROR: opendir');
  //   // return this.fs.promises.opendir(filePath, options);
  // }

  override async readdir(filePath: string, _options: object) { // eslint-disable-line @typescript-eslint/no-unused-vars
    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      MaxKeys: 1000, // TODO: Deal with pagination
      Prefix: filePath.replace(/^\//, '').replace(/\/$/, '').replace(/$/, '/'),
      Delimiter: '/',
    });
    const response = await this.s3.send(command);

    const keys = response.Contents?.map((content) => content.Key) || [];
    keys.push(...response.CommonPrefixes?.map((prefix) => prefix.Prefix) || []);

    return keys.filter(Boolean) as string[];
  }

  override async mkdir(filePath: string, _options = { recursive: true }) { // eslint-disable-line @typescript-eslint/no-unused-vars, class-methods-use-this
    // This is a noop on S3
    return filePath;
  }

  override async move(source: string, target: string) {
    let keys: string[] = [];

    if (await this.exists(source)) {
      keys = [source.replace(/^\//, '')];
    } else {
      const keysCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        MaxKeys: 1000, // TODO: Deal with pagination
        Prefix: source.replace(/^\//, ''),
      });
      const response = await this.s3.send(keysCommand);
      keys = (response.Contents || []).map((content) => content.Key).filter(Boolean) as string[];
    }

    const promises = keys.map((srcKey) => {
      const dstKey = srcKey.replace(source.replace(/^\//, ''), target.replace(/^\//, ''));

      const command = new CopyObjectCommand({
        Bucket: this.bucketName,
        CopySource: `${this.bucketName}/${srcKey}`,
        Key: dstKey,
      });

      return this.s3.send(command);
    });

    await Promise.all(promises);

    await Promise.all(keys.map((key) => this.remove(key)));
  }

  // FIXME: Does the API ever assume you remove directories and we need to remove the sub paths?
  override async remove(filePath: string) {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: filePath.replace(/^\//, ''),
    });

    await this.s3.send(command);
  }
}
