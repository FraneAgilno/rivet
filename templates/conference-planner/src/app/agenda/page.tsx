import { conferenceSessions } from '@/domain/sessions';
import { ConferencePlanner } from '@/features/agenda/ConferencePlanner';

export default function AgendaPage() {
  return <ConferencePlanner sessions={conferenceSessions} />;
}
