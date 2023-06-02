import fs from 'fs';
import path from 'path';
import os from 'os';
import { glob } from 'glob'; // eslint-disable-line import/no-extraneous-dependencies

import { S3 } from '@aws-sdk/client-s3';
import { sdkStreamMixin } from '@aws-sdk/util-stream-node'; // eslint-disable-line import/no-extraneous-dependencies

import S3rver from 's3rver'; // eslint-disable-line import/no-extraneous-dependencies

const bucketName = 'nabu-ocfl-test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocfl-js'));

const s3rver = new S3rver({
  configureBuckets: [{
    name: bucketName,
    configs: [],
  }],
  directory: tmpDir,
  silent: true,
});

const s3Config = {
  forcePathStyle: true,
  credentials: {
    accessKeyId: 'S3RVER',
    secretAccessKey: 'S3RVER',
  },
  endpoint: 'http://localhost:4568',
  region: 'ap-southeast-2',
};

const s3 = new S3(s3Config);

const preparebucket = async () => {
  const files = await glob(path.join(__dirname, '../../ocfl-tests/test-data/fixtures/**/*'), { nodir: true });

  const promises = files.map(async (filePath) => {
    const fileContent = fs.readFileSync(filePath);
    const Key = filePath.replace(/^\//, '');

    await s3.putObject({
      Bucket: bucketName,
      Key,
      Body: fileContent,
    });
  });

  await Promise.all(promises);
};

before(async () => {
  await s3rver.run();
  await preparebucket();
});

after(async () => {
  s3rver.close();
});

export const helpers = {
  getFile: async (filePath: string) => {
    const params = {
      Bucket: bucketName,
      Key: filePath.replace(/^\//, ''),
    };

    const { Body } = await s3.getObject(params);

    return sdkStreamMixin(Body).transformToString();
  },
};

export const storeConfig = {
  bucketName,
  s3,
};
