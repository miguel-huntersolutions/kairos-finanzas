import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Gastos del hogar',
  description: 'Tablero de Kairos Finanzas: gastos del hogar en COP.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-CO">
      <body>{children}</body>
    </html>
  );
}
