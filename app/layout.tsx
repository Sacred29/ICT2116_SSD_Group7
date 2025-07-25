import './globals.css';
import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { decodeJwt } from '@/lib/jwt';
import Navbar from './(components)/navbar'; 
import { verifyRefreshToken } from './(model)/(auth)/(token)/verifyRefreshToken.route';

export const metadata: Metadata = {
  title: 'Event Booking App',
  description: 'Login and Register Demo',
};


export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get('refresh_token')?.value;
  
  const headerList = await headers(); 
  const nonce = headerList.get('x-nonce') ?? ''; 


  let email: string | null = null;
  let role: string | null = null;

  if (token) {
    try {
      const result = await verifyRefreshToken(token);
      if (!result.success) {
        fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/logout`);
      }
      else if (result.success) {
        email = result.payload.user_email ?? null;
        role = result.payload.role ?? null;
      }
      
    } catch (e) {
      console.error('Invalid token', e);
    }
  }

  return (
    <html lang="en">
      <head nonce={nonce}>
      </head>
      <body className="bg-black text-white">
        <Navbar email={email} role={role} />
        <main className="p-6">{children}</main>
      </body>
    </html>
  );
}
