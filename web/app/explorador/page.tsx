// El explorador VISA ahora es el tablero único en "/".
import { redirect } from 'next/navigation';

export default function Explorador() {
  redirect('/');
}
