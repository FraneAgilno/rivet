export type ConferenceSession = Readonly<{
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  track: 'product' | 'engineering' | 'design';
  speakers: readonly string[];
  room: string;
  capacity: number;
}>;

export const conferenceSessions: readonly ConferenceSession[] = Object.freeze([
  Object.freeze({
    id: 'session-opening-keynote',
    title: 'Designing dependable agentic products',
    startsAt: '2026-10-15T09:00:00.000Z',
    endsAt: '2026-10-15T09:45:00.000Z',
    track: 'product',
    speakers: Object.freeze(['Mira Kovač']),
    room: 'Auditorium A',
    capacity: 420,
  }),
  Object.freeze({
    id: 'session-agenda-workshop',
    title: 'Design a resilient personal agenda',
    startsAt: '2026-10-15T09:30:00.000Z',
    endsAt: '2026-10-15T10:15:00.000Z',
    track: 'design',
    speakers: Object.freeze(['Amara Okafor']),
    room: 'Workshop 1',
    capacity: 80,
  }),
  Object.freeze({
    id: 'session-runtime-guardrails',
    title: 'Runtime guardrails that fail closed',
    startsAt: '2026-10-15T10:15:00.000Z',
    endsAt: '2026-10-15T11:00:00.000Z',
    track: 'engineering',
    speakers: Object.freeze(['Noah Reed', 'Leila Marin']),
    room: 'Studio 2',
    capacity: 180,
  }),
  Object.freeze({
    id: 'session-evidence-led-design',
    title: 'Evidence-led design reviews',
    startsAt: '2026-10-15T11:30:00.000Z',
    endsAt: '2026-10-15T12:15:00.000Z',
    track: 'design',
    speakers: Object.freeze(['Sofia Adeyemi']),
    room: 'Gallery',
    capacity: 120,
  }),
  Object.freeze({
    id: 'session-portable-delivery',
    title: 'Portable delivery without hidden state',
    startsAt: '2026-10-15T13:30:00.000Z',
    endsAt: '2026-10-15T14:15:00.000Z',
    track: 'engineering',
    speakers: Object.freeze(['Elias Novak']),
    room: 'Studio 2',
    capacity: 180,
  }),
]);

export const conferenceSessionIds = Object.freeze(
  new Set(conferenceSessions.map(session => session.id)),
);
