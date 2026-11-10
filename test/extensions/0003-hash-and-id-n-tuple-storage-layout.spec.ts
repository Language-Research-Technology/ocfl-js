import assert from 'node:assert';
import { describe, it } from 'node:test';
import { storageLayout } from '../../src/index.ts';

const NAME = '0003-hash-and-id-n-tuple-storage-layout';
const configured = (params: Record<string, unknown>) => storageLayout({ extensionName: NAME, ...params });

describe('the 0003 hash and id n-tuple layout', () => {
  it('can map valid id with default config', () => {
    const layout = storageLayout(NAME);
    const ids: [string, string][] = [
      ['object-01', '3c0/ff4/240/object-01'],
      ['..hor/rib:le-$id', '487/326/d8c/%2e%2ehor%2frib%3ale-%24id'],
    ];
    for (const idp of ids) {
      assert.strictEqual(layout.map(idp[0]), idp[1]);
    }
  });

  it('can map valid id with tupleSize=2 and numberOfTuples=0', () => {
    const layout = configured({ digestAlgorithm: 'md5', tupleSize: 2, numberOfTuples: 15 });
    const ids: [string, string][] = [
      ['object-01', 'ff/75/53/44/92/48/5e/ab/b3/9f/86/35/67/28/88/object-01'],
      ['..hor/rib:le-$id', '08/31/97/66/fb/6c/29/35/dd/17/5b/94/26/77/17/%2e%2ehor%2frib%3ale-%24id'],
    ];
    for (const idp of ids) {
      assert.strictEqual(layout.map(idp[0]), idp[1]);
    }
  });

  describe('encapsulation directory', () => {
    const encapsulationDirectory = (id: string, digestAlgorithm = 'sha256') => configured({ digestAlgorithm, tupleSize: 0, numberOfTuples: 0 }).map(id);

    it("keeps the identifier's own letter case and lower-cases the percent-encoding", () => {
      assert.strictEqual(encapsulationDirectory('..Hor/rib:lè-$id'), '%2e%2eHor%2frib%3al%c3%a8-%24id');
    });

    it('percent-encodes everything except letters, digits, hyphen and underscore', () => {
      assert.strictEqual(encapsulationDirectory("a!'()*~b"), 'a%21%27%28%29%2a%7eb');
      assert.strictEqual(encapsulationDirectory('Az-_09'), 'Az-_09');
    });

    const first100Chars = 'abcdefghij'.repeat(10);
    const id101Chars = `${first100Chars}a`;
    const id101CharsSha256 = '5cc73e648fbcff136510e330871180922ddacf193b68fdeff855683a01464220';

    it('keeps an identifier that encodes to exactly 100 characters', () => {
      assert.strictEqual(encapsulationDirectory(first100Chars), first100Chars);
    });

    it('truncates an identifier that encodes to more than 100 characters and appends its digest', () => {
      assert.strictEqual(encapsulationDirectory(id101Chars), `${first100Chars}-${id101CharsSha256}`);
    });

    it('measures the encoded identifier, not the original', () => {
      assert.strictEqual(encapsulationDirectory(`${'/'.repeat(33)}a`), `${'%2f'.repeat(33)}a`);
      assert.strictEqual(encapsulationDirectory('/'.repeat(34)), `${'%2f'.repeat(33)}%-1f62aeee9540aa9022a24e0c65a754e3434d310c30a4ecc682361bde1e7a8760`);
    });

    it('truncates using the configured digestAlgorithm', () => {
      assert.strictEqual(encapsulationDirectory(id101Chars, 'md5'), `${first100Chars}-6b302f372e9f340c58d7366ec90ab6df`);
    });

    it('still prefixes a truncated directory with the digest tuples', () => {
      const layout = storageLayout(NAME);
      assert.strictEqual(layout.map(id101Chars), `5cc/73e/648/${first100Chars}-${id101CharsSha256}`);
    });
  });

  it('rejects a digestAlgorithm that is not lowercase', () => {
    assert.throws(() => configured({ digestAlgorithm: 'MD5' }), { code: 'INVALID_LAYOUT_CONFIG', message: /digestAlgorithm .*'MD5'/ });
  });

  it('rejects an unknown digestAlgorithm', () => {
    assert.throws(() => configured({ digestAlgorithm: 'sha3' }), { code: 'INVALID_LAYOUT_CONFIG', message: /digestAlgorithm .*'sha3'/ });
  });

  it('can map valid id with tupleSize=0 and numberOfTuples=0', () => {
    const layout = configured({ digestAlgorithm: 'sha256', tupleSize: 0, numberOfTuples: 0 });
    const ids: [string, string][] = [
      ['object-01', 'object-01'],
      ['..hor/rib:le-$id', '%2e%2ehor%2frib%3ale-%24id'],
    ];
    for (const idp of ids) {
      assert.strictEqual(layout.map(idp[0]), idp[1]);
    }
  });
});
