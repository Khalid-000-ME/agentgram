/** Crypto protocol tests: handshake, ratchet, groups, franking, ids. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as C from '@agentline/crypto';

function pair() {
  const aStore = C.newKeyStore(), bStore = C.newKeyStore();
  const a = C.identityFromStore(aStore), b = C.identityFromStore(bStore);
  const pub = C.publishablePrekeys(bStore, { oneTime: 5, pq: 3 });
  const bundle: C.PrekeyBundle = {
    suite: pub.suite, agentId: pub.agentId, deviceId: pub.deviceId, bundleId: pub.bundleId,
    ed25519Pk: pub.ed25519Pk, x25519Pk: pub.x25519Pk, signedPrekey: pub.signedPrekey,
    oneTimePrekey: pub.oneTimePrekeys[0], pqPrekey: pub.pqPrekeys[0], keyEpoch: 1,
  };
  return { aStore, bStore, a, b, bundle };
}

test('agent ids derive from the identity key and are stable', () => {
  const id = C.generateIdentity();
  assert.equal(C.deriveAgentId(id.ed25519Pk), id.agentId);
  assert.match(id.agentId, /^agt_[a-z2-7]{32}$/);
  assert.equal(C.bytes32ToId('agt', C.idToBytes32(id.agentId)), id.agentId);
});

test('conversation ids are symmetric and salt-dependent', () => {
  const a = C.generateIdentity().agentId, b = C.generateIdentity().agentId;
  assert.equal(C.deriveConversationId(a, b), C.deriveConversationId(b, a));
  const salt = C.newConvSalt();
  assert.equal(C.deriveConversationId(a, b, salt), C.deriveConversationId(b, a, salt));
  assert.notEqual(C.deriveConversationId(a, b), C.deriveConversationId(a, b, salt));
});

test('prekey bundle verification rejects a substituted identity key', () => {
  const { bundle } = pair();
  C.verifyPrekeyBundle(bundle, bundle.ed25519Pk);
  const other = C.generateIdentity();
  assert.throws(() => C.verifyPrekeyBundle(bundle, C.b64.enc(other.ed25519Pk)), /differs from registry/);
});

test('prekey bundle verification rejects a forged signed prekey', () => {
  const { bundle } = pair();
  const forged = { ...bundle, signedPrekey: { ...bundle.signedPrekey, pk: C.b64.enc(C.x25519.getPublicKey(C.x25519.utils.randomPrivateKey())) } };
  assert.throws(() => C.verifyPrekeyBundle(forged), /signed prekey signature invalid/);
});

test('PQXDH handshake plus double ratchet round trips both ways', () => {
  const { aStore, bStore, a, bundle } = pair();
  const cid = C.deriveConversationId(a.agentId, bundle.agentId);
  const aad = C.utf8.enc(cid);
  const A = C.initiateSession(a, bundle, cid, { pq: true });
  assert.equal(A.suite, 'AGL-1-PQ');

  const m1 = C.ratchetEncrypt(A, C.utf8.enc('hello'), aad);
  const B = C.acceptSession(bStore, m1.hs!, cid, 'dev_x');
  assert.equal(C.utf8.dec(C.ratchetDecrypt(B, m1, aad)), 'hello');
  // the responder learns who is calling from the handshake itself
  assert.equal(B.peerAgentId, a.agentId);

  const r1 = C.ratchetEncrypt(B, C.utf8.enc('hi back'), aad);
  assert.equal(C.utf8.dec(C.ratchetDecrypt(A, r1, aad)), 'hi back');
  const m2 = C.ratchetEncrypt(A, C.utf8.enc('and again'), aad);
  assert.equal(C.utf8.dec(C.ratchetDecrypt(B, m2, aad)), 'and again');
});

test('one-time prekeys are consumed exactly once', () => {
  const { aStore, bStore, a, bundle } = pair();
  const cid = 'cnv_test';
  const A = C.initiateSession(a, bundle, cid, { pq: false });
  const m1 = C.ratchetEncrypt(A, C.utf8.enc('x'), C.utf8.enc(cid));
  C.acceptSession(bStore, m1.hs!, cid, 'dev_x');
  assert.throws(() => C.acceptSession(bStore, m1.hs!, cid, 'dev_x'), /already consumed/);
});

test('out-of-order and skipped messages still decrypt', () => {
  const { bStore, a, bundle } = pair();
  const cid = 'cnv_ooo';
  const aad = C.utf8.enc(cid);
  const A = C.initiateSession(a, bundle, cid);
  const first = C.ratchetEncrypt(A, C.utf8.enc('1'), aad);
  const B = C.acceptSession(bStore, first.hs!, cid, 'dev_x');
  C.ratchetDecrypt(B, first, aad);
  const msgs = ['2', '3', '4'].map((t) => C.ratchetEncrypt(A, C.utf8.enc(t), aad));
  // deliver 4, then 2, then 3
  assert.equal(C.utf8.dec(C.ratchetDecrypt(B, msgs[2], aad)), '4');
  assert.equal(C.utf8.dec(C.ratchetDecrypt(B, msgs[0], aad)), '2');
  assert.equal(C.utf8.dec(C.ratchetDecrypt(B, msgs[1], aad)), '3');
});

test('ciphertext is bound to its header and to the conversation', () => {
  const { bStore, a, bundle } = pair();
  const cid = 'cnv_aad';
  const A = C.initiateSession(a, bundle, cid);
  const m = C.ratchetEncrypt(A, C.utf8.enc('secret'), C.utf8.enc(cid));
  const B = C.acceptSession(bStore, m.hs!, cid, 'dev_x');
  const snapshot = () => JSON.parse(JSON.stringify(B)) as C.SessionState;

  // wrong conversation in the AAD
  assert.throws(() => C.ratchetDecrypt(snapshot(), m, C.utf8.enc('cnv_other')), /invalid tag/i);
  // tampered header (the header is part of what the AEAD authenticates)
  assert.throws(() => C.ratchetDecrypt(snapshot(), { ...m, hdr: { ...m.hdr, n: 5 } }, C.utf8.enc(cid)));
  // tampered ciphertext
  const flipped = C.b64.dec(m.ct); flipped[flipped.length - 1] ^= 0xff;
  assert.throws(() => C.ratchetDecrypt(snapshot(), { ...m, ct: C.b64.enc(flipped) }, C.utf8.enc(cid)));
  // the untouched message still opens
  assert.equal(C.utf8.dec(C.ratchetDecrypt(B, m, C.utf8.enc(cid))), 'secret');
});

test('crypto-shredding makes retained ciphertext unreadable', () => {
  const { bStore, a, bundle } = pair();
  const cid = 'cnv_shred';
  const aad = C.utf8.enc(cid);
  const A = C.initiateSession(a, bundle, cid);
  const m1 = C.ratchetEncrypt(A, C.utf8.enc('one'), aad);
  const B = C.acceptSession(bStore, m1.hs!, cid, 'dev_x');
  C.ratchetDecrypt(B, m1, aad);
  const m2 = C.ratchetEncrypt(A, C.utf8.enc('two'), aad);
  C.shredSession(B);
  assert.throws(() => C.ratchetDecrypt(B, m2, aad));
});

test('safety numbers agree on both sides and change with the key', () => {
  const a = C.generateIdentity(), b = C.generateIdentity(), c = C.generateIdentity();
  assert.equal(C.safetyNumber(a.ed25519Pk, b.ed25519Pk), C.safetyNumber(b.ed25519Pk, a.ed25519Pk));
  assert.notEqual(C.safetyNumber(a.ed25519Pk, b.ed25519Pk), C.safetyNumber(a.ed25519Pk, c.ed25519Pk));
});

test('group sender keys work and epoch rotation locks out removed members', () => {
  const alice = C.generateIdentity().agentId, bob = C.generateIdentity().agentId, carol = C.generateIdentity().agentId;
  const gid = C.deriveGroupId(alice, C.randomBytes(16));
  const gA = C.createGroup(gid, alice, [bob, carol]);
  const gB = C.createGroup(gid, alice, [bob, carol]);
  const gC = C.createGroup(gid, alice, [bob, carol]);
  C.acceptDistribution(gB, C.distribution(gA, alice));
  C.acceptDistribution(gC, C.distribution(gA, alice));

  const m = C.groupEncrypt(gA, C.utf8.enc('hello group'));
  assert.equal(C.utf8.dec(C.groupDecrypt(gB, alice, m)), 'hello group');
  assert.equal(C.utf8.dec(C.groupDecrypt(gC, alice, m)), 'hello group');

  C.rotateEpoch(gA, [alice, bob]);          // carol removed
  const after = C.groupEncrypt(gA, C.utf8.enc('members only'));
  assert.throws(() => C.groupDecrypt(gC, alice, after));   // carol cannot read the new epoch
  // A distribution carries the epoch's seed, so a member who receives it after the message
  // was sent can still read that message.
  C.acceptDistribution(gB, C.distribution(gA, alice));
  assert.equal(C.utf8.dec(C.groupDecrypt(gB, alice, after)), 'members only');
  // Re-applying the same distribution must not rewind the chain and re-open a used key.
  C.acceptDistribution(gB, C.distribution(gA, alice));
  assert.throws(() => C.groupDecrypt(gB, alice, after), /already consumed/);
});

test('group messages arriving out of order still decrypt', () => {
  const alice = C.generateIdentity().agentId, bob = C.generateIdentity().agentId;
  const gid = C.deriveGroupId(alice, C.randomBytes(16));
  const gA = C.createGroup(gid, alice, [bob]);
  const gB = C.createGroup(gid, alice, [bob]);
  C.acceptDistribution(gB, C.distribution(gA, alice));
  const msgs = [1, 2, 3].map((n) => C.groupEncrypt(gA, C.utf8.enc(`m${n}`)));
  assert.equal(C.utf8.dec(C.groupDecrypt(gB, alice, msgs[2])), 'm3');
  assert.equal(C.utf8.dec(C.groupDecrypt(gB, alice, msgs[0])), 'm1');
  assert.equal(C.utf8.dec(C.groupDecrypt(gB, alice, msgs[1])), 'm2');
});

test('membership root is order-independent and change-sensitive', () => {
  const a = C.generateIdentity().agentId, b = C.generateIdentity().agentId, c = C.generateIdentity().agentId;
  assert.equal(C.membersRoot([a, b, c]), C.membersRoot([c, a, b]));
  assert.notEqual(C.membersRoot([a, b, c]), C.membersRoot([a, b]));
});

test('franking proves authorship of a reported body and rejects tampering', () => {
  const key = C.newFrankKey();
  const body = { type: 'text', body: { text: 'reported content' } };
  const tag = C.frankingTag(key, C.utf8.enc(JSON.stringify(body)));
  assert.equal(C.verifyFrankingJson(C.b64.enc(key), body, tag), true);
  assert.equal(C.verifyFrankingJson(C.b64.enc(key), { ...body, body: { text: 'altered' } }, tag), false);
  assert.equal(C.verifyFrankingJson(C.b64.enc(C.newFrankKey()), body, tag), false);
});

test('ciphertext is padded into size buckets so length leaks little', () => {
  const short = C.pad(C.utf8.enc('hi')).length;
  const medium = C.pad(C.utf8.enc('x'.repeat(200))).length;
  assert.equal(short, 128);
  assert.equal(medium, 256);
  assert.equal(C.utf8.dec(C.unpad(C.pad(C.utf8.enc('round trip')))), 'round trip');
});

test('simple mode sealed box works for stateless agents', () => {
  const id = C.generateIdentity();
  const sealed = C.sealTo(id.x25519Pk, C.utf8.enc('stateless hello'));
  assert.equal(C.utf8.dec(C.openSealed(id.x25519Sk, sealed)), 'stateless hello');
  const other = C.generateIdentity();
  assert.throws(() => C.openSealed(other.x25519Sk, sealed));
});

test('personal index seals and opens only with the identity secret', () => {
  const id = C.generateIdentity();
  const index = C.emptyIndex();
  index.contacts['agt_x'] = { agentId: 'agt_x', addedAt: 1 };
  const blob = C.sealIndex(id.ed25519Sk, index);
  assert.equal(C.openIndex(id.ed25519Sk, blob).contacts['agt_x'].agentId, 'agt_x');
  assert.throws(() => C.openIndex(C.generateIdentity().ed25519Sk, blob));
});

test('handles are normalised and validated', () => {
  assert.equal(C.normalizeHandle('@Booking.Bot'), 'booking.bot');
  assert.throws(() => C.normalizeHandle('ab'));
  assert.throws(() => C.normalizeHandle('has spaces'));
  assert.equal(C.handleHash('@X'.padEnd(5, 'y')), C.handleHash('x' + 'y'.repeat(3)));
});
