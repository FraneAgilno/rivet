import { randomUUID } from 'node:crypto';
import { evaluateAuthority } from '../policy/authority.js';
import {
  ACTIONS,
  candidate,
  digest,
  ensure,
  exact,
  fail,
  factsDigest,
  hash,
  id,
  mergeReceiptFor,
  observation,
  plain,
  ready,
  timestamp,
  validateReceipt,
} from './contract.js';
import { isDeliveryStore } from './store.js';
const executors = new WeakSet();
const inFlight = new Map();

// Only trusted application code may create an executor. A succeeded receipt must
// describe a provider-verified effect for the exact operation; not-applied means
// terminal proof that no effect occurred or can later occur. An eventually
// consistent absence check is not sufficient. Native transports are not qualified
// by this constructor: conditional mutation and reconciliation remain obligations
// of the implementation supplied here.
export function createTrustedDeliveryExecutor(input) {
  ensure(input && typeof input === 'object');
  const { provider, capabilities } = input;
  ensure(['github', 'bitbucket', 'gitlab'].includes(provider));
  const captured = plain(capabilities);
  ensure(Array.isArray(captured) && captured.length <= ACTIONS.length);
  for (const capability of captured) {
    exact(capability, ['action', 'conditionalHead', 'reconcile']);
    ensure(
      ACTIONS.includes(capability.action) &&
        capability.conditionalHead === true &&
        capability.reconcile === true
    );
  }
  ensure(new Set(captured.map((value) => value.action)).size === captured.length);
  const unavailable = () => fail('executor-unavailable');
  for (const method of ['observe', 'dispatch', 'reconcile'])
    ensure(input[method] === undefined || typeof input[method] === 'function');
  if (captured.length)
    ensure(
      typeof input.observe === 'function' &&
        typeof input.dispatch === 'function' &&
        typeof input.reconcile === 'function'
    );
  const executor = Object.freeze({
    provider,
    capabilities: captured,
    observe: input.observe ?? unavailable,
    dispatch: input.dispatch ?? unavailable,
    reconcile: input.reconcile ?? unavailable,
  });
  executors.add(executor);
  return executor;
}
export function createDeliveryService(config) {
  const { store, executor, authority, approvalRegistry, expectedApproverId, subjectId, providerId } = config;
  ensure(isDeliveryStore(store) && executors.has(executor));
  id(expectedApproverId);
  id(subjectId);
  id(providerId);
  const clock = config.clock ?? (() => new Date().toISOString());
  ensure(typeof clock === 'function');
  const timeoutMs = config.timeoutMs ?? 10000;
  ensure(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 120000);
  const now = () => timestamp(clock());
  const active = (state) =>
    state.operations.some((value) => ['dispatching', 'indeterminate'].includes(value.state));
  function writable(state) {
    ensure(!active(state), 'reconciliation-required');
  }
  async function load(version) {
    const state = await store.read();
    ensure(state !== null, 'missing-state');
    ensure(state.candidate.repository.provider === executor.provider, 'provider-mismatch');
    if (version !== undefined)
      ensure(Number.isSafeInteger(version) && state.version === version, 'version-conflict');
    return state;
  }
  async function save(state, changes) {
    const { version, ...record } = state;
    return store.write({ ...record, ...changes, updatedAt: now() }, { expectedVersion: version });
  }
  async function bounded(operation) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function observe(target) {
    const result = observation(await bounded(() => executor.observe(target)), target);
    ensure(
      Date.parse(result.observedAt) <= Date.parse(now()) &&
        Date.parse(now()) - Date.parse(result.observedAt) <= 300000,
      'stale-observation'
    );
    return result;
  }
  function observedStage(state, facts) {
    if (['merged', 'deployed', 'tracker-updated'].includes(state.stage)) return state.stage;
    return ready(facts)
      ? 'checks-passed'
      : facts.review ||
          state.operations.some(
            (operation) => operation.action === 'review-request' && operation.state === 'succeeded'
          )
        ? 'review-requested'
        : 'locally-verified';
  }
  function allowed(state, action) {
    ensure(
      executor.capabilities.some((value) => value.action === action),
      'unsupported-action'
    );
    if (action === 'merge')
      ensure(
        ready(state.observation) &&
          !state.operations.some((value) => value.action === 'merge' && value.state === 'succeeded'),
        'not-ready'
      );
    else if (action === 'review-request')
      ensure(
        state.observation?.review === null &&
          state.stage === 'locally-verified' &&
          !state.operations.some(
            (operation) => operation.action === 'review-request' && operation.state === 'succeeded'
          ),
        'not-ready'
      );
    else if (action === 'deploy') ensure(state.stage === 'merged', 'not-ready');
    else ensure(['merged', 'deployed'].includes(state.stage), 'not-ready');
  }
  async function initialize(input) {
    const target = candidate(input);
    ensure(target.repository.provider === executor.provider);
    ensure(Date.parse(target.localVerification.verifiedAt) <= Date.parse(now()), 'invalid-verification');
    return store.exclusive(async () => {
      ensure((await store.read()) === null, 'state-exists');
      const at = now();
      return store.write(
        {
          schemaVersion: 1,
          stage: 'locally-verified',
          candidate: target,
          observation: null,
          proposal: null,
          operations: [],
          usedApprovalIds: [],
          createdAt: at,
          updatedAt: at,
        },
        { expectedVersion: 0 }
      );
    });
  }
  async function refresh(input) {
    const request = plain(input);
    exact(request, ['expectedVersion']);
    return store.exclusive(async () => {
      const state = await load(request.expectedVersion);
      writable(state);
      const facts = await observe(state.candidate);
      return save(state, { observation: facts, proposal: null, stage: observedStage(state, facts) });
    });
  }
  async function propose(input) {
    const request = plain(input);
    exact(request, ['expectedVersion', 'action', 'payload', 'expiresAt']);
    ensure(ACTIONS.includes(request.action));
    ensure(request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload));
    timestamp(request.expiresAt);
    ensure(
      Date.parse(request.expiresAt) > Date.parse(now()) &&
        Date.parse(request.expiresAt) - Date.parse(now()) <= 3600000,
      'expired-proposal'
    );
    return store.exclusive(async () => {
      const state = await load(request.expectedVersion);
      writable(state);
      ensure(state.observation !== null, 'observation-required');
      allowed(state, request.action);
      const facts = await observe(state.candidate);
      const observed = { ...state, observation: facts };
      allowed(observed, request.action);
      const body = {
        candidate: state.candidate,
        action: request.action,
        payload: request.payload,
        expiresAt: request.expiresAt,
        factsDigest: factsDigest(facts),
        nonce: randomUUID(),
        mergeReceipt: mergeReceiptFor(state.operations, request.action),
        providerId,
      };
      const proposalDigest = hash(body);
      const resource = `delivery:${proposalDigest}`;
      return save(state, {
        observation: facts,
        proposal: {
          digest: proposalDigest,
          action: body.action,
          payload: body.payload,
          expiresAt: body.expiresAt,
          factsDigest: body.factsDigest,
          nonce: body.nonce,
          mergeReceipt: body.mergeReceipt,
          providerId,
          resource,
          approvalResource: `${providerId}:${body.action}:${resource}`,
        },
      });
    });
  }
  async function finish(state, operation, receipt) {
    const success = validateReceipt(receipt, operation);
    const operations = state.operations.map((item) =>
      item.digest === operation.digest ? { ...item, state: 'succeeded', receipt: success } : item
    );
    const stage = {
      'review-request': 'review-requested',
      merge: 'merged',
      deploy: 'deployed',
      'tracker-update': 'tracker-updated',
    }[operation.action];
    return save(state, { operations, proposal: null, stage });
  }
  async function execute(input) {
    ensure(input && typeof input === 'object' && !Array.isArray(input));
    for (const key of Reflect.ownKeys(input)) {
      ensure(typeof key === 'string' && ['expectedVersion', 'proposalDigest', 'approval'].includes(key));
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      ensure(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
    }
    const approval = input.approval;
    const request = plain({ expectedVersion: input.expectedVersion, proposalDigest: input.proposalDigest });
    ensure(Object.keys(input).length === 3 && Object.hasOwn(input, 'approval'));
    digest(request.proposalDigest);
    return store.exclusive(async () => {
      let state = await load(request.expectedVersion);
      writable(state);
      const proposal = state.proposal;
      ensure(
        proposal && proposal.digest === request.proposalDigest && proposal.providerId === providerId,
        'proposal-mismatch'
      );
      ensure(Date.parse(proposal.expiresAt) > Date.parse(now()), 'expired-proposal');
      allowed(state, proposal.action);
      const facts = await observe(state.candidate);
      ensure(factsDigest(facts) === proposal.factsDigest, 'changed-facts');
      allowed({ ...state, observation: facts }, proposal.action);
      ensure(Date.parse(proposal.expiresAt) > Date.parse(now()), 'expired-proposal');
      ensure(
        approval?.singleUse === true && !state.usedApprovalIds.includes(approval.id),
        'approval-replayed'
      );
      const decision = evaluateAuthority(
        authority,
        {
          actorId: subjectId,
          action: 'provider.write',
          resource: proposal.resource,
          providerId,
          capability: proposal.action,
        },
        { approval, approvalRegistry, expectedApproverId, nowMs: Date.parse(now()) }
      );
      ensure(decision.decision === 'allow', 'approval-required');
      const operation = plain({
        digest: proposal.digest,
        action: proposal.action,
        payload: proposal.payload,
        candidate: state.candidate,
        factsDigest: proposal.factsDigest,
        mergeReceipt: proposal.mergeReceipt,
        approvalId: approval.id,
        dispatchedAt: now(),
        state: 'dispatching',
        receipt: null,
      });
      state = await save(state, {
        operations: [...state.operations, operation],
        usedApprovalIds: [...state.usedApprovalIds, approval.id],
        stage: proposal.action === 'merge' ? 'merge-approved' : state.stage,
      });
      if (Date.parse(now()) >= Math.min(Date.parse(proposal.expiresAt), Date.parse(approval.expiresAt))) {
        return save(state, {
          operations: state.operations.map((value) =>
            value.digest === operation.digest ? { ...value, state: 'not-applied' } : value
          ),
          proposal: null,
          stage: observedStage(
            { ...state, stage: proposal.action === 'merge' ? 'checks-passed' : state.stage },
            facts
          ),
        });
      }
      let receipt;
      try {
        receipt = await bounded(() => {
          const pending = inFlight;
          const promise = Promise.resolve().then(() => executor.dispatch(operation));
          pending.set(operation.digest, promise);
          promise.then(
            () => pending.delete(operation.digest),
            () => pending.delete(operation.digest)
          );
          return promise;
        });
        validateReceipt(receipt, operation);
      } catch {
        return save(state, {
          operations: state.operations.map((value) =>
            value.digest === operation.digest ? { ...value, state: 'indeterminate' } : value
          ),
        });
      }
      return finish(state, operation, receipt);
    });
  }
  async function reconcile(input) {
    const request = plain(input);
    exact(request, ['expectedVersion']);
    return store.exclusive(async () => {
      const state = await load(request.expectedVersion);
      const operation = state.operations.find((value) =>
        ['dispatching', 'indeterminate'].includes(value.state)
      );
      ensure(operation, 'nothing-to-reconcile');
      let result;
      try {
        result = inFlight.has(operation.digest)
          ? { status: 'unknown' }
          : plain(await bounded(() => executor.reconcile(operation)));
        if (result.status === 'succeeded') {
          exact(result, ['status', 'receipt']);
          validateReceipt(result.receipt, operation);
        } else {
          exact(result, ['status']);
          ensure(['not-applied', 'unknown'].includes(result.status));
        }
      } catch {
        result = { status: 'unknown' };
      }
      if (result.status === 'succeeded') return finish(state, operation, result.receipt);
      const operations = state.operations.map((value) =>
        value.digest === operation.digest
          ? { ...value, state: result.status === 'not-applied' ? 'not-applied' : 'indeterminate' }
          : value
      );
      return save(state, { operations, ...(result.status === 'not-applied' ? { proposal: null } : {}) });
    });
  }
  return Object.freeze({ initialize, refresh, propose, execute, reconcile, status: () => store.read() });
}
