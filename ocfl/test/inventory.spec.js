//@ts-check
"use strict";

const assert = require("assert");
const { readFile } = require("fs/promises");
const { OcflObjectInventory } = require("../lib/inventory");

describe("OcflObjectInventory class", function () {
  let data;
  beforeEach(function(){
    data = {
      id: 'id1',
      digestAlgorithm: 'sha512',
      type: `https://ocfl.io/1.1/spec/#inventory`,
      head: '',
      manifest: {},
      versions: {}
    };
  });

  it("can create empty inventory", function () {
    let digest = "testdigest123";
    let inv = new OcflObjectInventory(data);
    //assert.strictEqual(digest, inv.cachedDigest);
    assert.strictEqual(data.id, inv.id);
    assert.strictEqual(data.digestAlgorithm, inv.digestAlgorithm);
    assert.strictEqual(data.type, inv.type);
    assert.strictEqual('content', inv.contentDirectory);
    assert.strictEqual('', inv.head);
  });

  it("can load inventory", async function () {
    let digest = "8e280eb94af68d27f635c2013531d4cf41c6089dfa8ffeeb4f0230500203fab9c10f929c08057f5d1b5084ab4dff7d72fb20010bf4cbf713569fadfc9257770a";
    let data = JSON.parse(await readFile('test-data/inventory.json', 'utf8'));
    let inv = new OcflObjectInventory(data);
    assert.strictEqual(digest, await inv.digest());
    assert.strictEqual(data.id, inv.id);
    assert.strictEqual(data.digestAlgorithm, inv.digestAlgorithm);
    assert.strictEqual(data.type, inv.type);
  });

  it("can create new version", function () {
    let inv = OcflObjectInventory.newVersion(data);
    assert.strictEqual(inv.head, 'v1');
    assert.strictEqual(typeof inv.versions.v1, 'object');
    assert.strictEqual(Object.keys(inv.versions.v1.state).length, 0);
  });

  it("can create new version from existing", async function () {
    let data = JSON.parse(await readFile('test-data/inventory.json', 'utf8'));
    let inv = OcflObjectInventory.newVersion(data);
    //console.log(inv.toJSON());
    let data2 = inv.toJSON();
    assert.strictEqual(data2.head, 'v4');
    assert.deepStrictEqual(data2.versions.v4.state, data.versions.v3.state);
  });

  it("can add file to a new version", function () {
    let inv = OcflObjectInventory.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    let data2 = inv.toJSON();
    assert.strictEqual(inv.head, 'v1');
    assert.strictEqual(inv.manifest['aabbccddeeff'][0], 'v1/content/test.txt');
    assert.deepStrictEqual(data2.manifest, inv.manifest);
  });

  it("can add file with identical content but different name", function () {
    let inv = OcflObjectInventory.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    inv.add('test2.txt', 'aabbccddeeff');
    assert.strictEqual(inv.head, 'v1');
    assert.strictEqual(inv.manifest['aabbccddeeff'][0], 'v1/content/test.txt');
    assert.strictEqual(inv.manifest['aabbccddeeff'].length, 1);
    assert.strictEqual(Object.keys(inv.manifest).length, 1);
    assert.strictEqual(inv.versions.v1.state['aabbccddeeff'][0], 'test.txt');
    assert.strictEqual(inv.versions.v1.state['aabbccddeeff'][1], 'test2.txt');
    assert.strictEqual(inv.versions.v1.state['aabbccddeeff'].length, 2);
    assert.strictEqual(Object.keys(inv.versions.v1.state).length, 1);
  });

  it("can add file with identical content and name", function () {
    let inv = OcflObjectInventory.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv.add('test.txt', 'aabbccddeeff');
    assert.strictEqual(inv.manifest['aabbccddeeff'][0], 'v1/content/test.txt');
    assert.strictEqual(inv.manifest['aabbccddeeff'].length, 1);
    assert.strictEqual(Object.keys(inv.manifest).length, 1);
    assert.strictEqual(inv.versions.v1.state['aabbccddeeff'][0], 'test.txt');
    assert.strictEqual(inv.versions.v1.state['aabbccddeeff'].length, 1);
    assert.strictEqual(Object.keys(inv.versions.v1.state).length, 1);
    assert.strictEqual(inv.versions.v2.state['aabbccddeeff'][0], 'test.txt');
    assert.strictEqual(inv.versions.v2.state['aabbccddeeff'].length, 1);
    assert.strictEqual(Object.keys(inv.versions.v2.state).length, 1);
  });

  it("can add file with different content but identical name", function () {
    let inv = OcflObjectInventory.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv.add('test.txt', 'aabbccddeeff2');
    assert.strictEqual(inv.manifest['aabbccddeeff'][0], 'v1/content/test.txt');
    assert.strictEqual(inv.manifest['aabbccddeeff2'][0], 'v2/content/test.txt');
    assert.strictEqual(Object.keys(inv.manifest).length, 2);
    assert.strictEqual(inv.versions.v2.state['aabbccddeeff2'][0], 'test.txt');
    assert.strictEqual(inv.versions.v2.state['aabbccddeeff2'].length, 1);
    assert.strictEqual(Object.keys(inv.versions.v1.state).length, 1);
    assert.strictEqual(Object.keys(inv.versions.v2.state).length, 1);
  });

  it("can add same file after it has been deleted", function () {
    let inv = OcflObjectInventory.newVersion(data);
    inv.add('test.txt', 'aabbccddeeff');
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv.add('test.txt', 'aabbccddeeff2'); // aabbccddeeff effectively deleted from v2
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    inv.add('test.txt', 'aabbccddeeff'); // reinstatement
    assert.strictEqual(Object.keys(inv.manifest).length, 2);
    assert.strictEqual(inv.versions.v3.state['aabbccddeeff'][0], 'test.txt');
    assert.strictEqual(inv.versions.v3.state['aabbccddeeff'].length, 1);
    assert.strictEqual(Object.keys(inv.versions.v3.state).length, 1);
  });

  it("can detect state change", function () {
    let inv = OcflObjectInventory.newVersion(data);
    assert.ok(!inv.isChanged);
    inv.add('test.txt', 'aabbccddeeff');
    assert.ok(inv.isChanged);
    inv = OcflObjectInventory.newVersion(inv.toJSON());
    assert.ok(!inv.isChanged);
    inv.add('test.txt', 'aabbccddeeff');
    assert.ok(!inv.isChanged);
    inv.add('test1.txt', 'aabbccddeeff');
    assert.ok(inv.isChanged);

  });

  it("can iterate files", async function () {
    let data = JSON.parse(await readFile('test-data/inventory.json', 'utf8'));
    let inv = new OcflObjectInventory(data);
    var files = [...inv.files()];
    assert.strictEqual(files[0].contentPath, 'v2/content/foo/bar.xml');
    assert.strictEqual(files[1].contentPath, 'v1/content/empty.txt');
    assert.strictEqual(files[2].contentPath, 'v1/content/image.tiff');
  });
});
