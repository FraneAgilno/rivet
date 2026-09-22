import { describe, expect, it } from 'vitest';

import { conferenceSessions } from '../src/domain/conference';

describe('seeded conference program', () => {
  it('has stable unique IDs and valid schedules', () => {
    expect(new Set(conferenceSessions.map(session => session.id)).size).toBe(conferenceSessions.length);
    for (const session of conferenceSessions) {
      expect(new Date(session.startsAt).getTime()).toBeLessThan(new Date(session.endsAt).getTime());
      expect(session.capacity).toBeGreaterThan(0);
    }
  });
});
