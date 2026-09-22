import { conferenceSessions } from '@/domain/sessions';
import { ConferencePlanner } from '@/features/agenda/ConferencePlanner';

export default function ConferencePage() {
  return <ConferencePlanner sessions={conferenceSessions} />;
}
