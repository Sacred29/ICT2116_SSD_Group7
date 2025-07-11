//backend to fetch all events and insert new event
export const runtime = 'nodejs'

import fs from 'fs/promises';
import path from 'path';
import { Buffer } from 'buffer';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { verifyRefreshToken } from '@/app/(model)/(auth)/(token)/verifyRefreshToken.route';


// Insert Event
export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get('refresh_token')?.value;
  if (!refreshToken) {
    return NextResponse.json({ success: false, message: 'No token' }, { status: 401 });
  }

  const {success, message, payload } = await verifyRefreshToken(refreshToken);
  
  if (!success) {
    return NextResponse.json({ success: false, message: 'Invalid token' }, { status: 401 });
  }

  if (payload.role !== 'admin' && payload.role !== 'owner') {
    return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 });
  }
  try {
    const formData = await req.formData();

    const title = formData.get('title') as string;
    const description = formData.get('description') as string;
    const location = formData.get('location') as string;
    const file = formData.get('picture') as File;

    // Get event_dates as a JSON string then parse
    const datesRaw = formData.get('dates') as string;
    const dates = JSON.parse(datesRaw); // expects [{ event_date: '2025-05-30', start_time: '18:00', end_time: '21:00' }, ...]

    const categoriesRaw = formData.get('categories') as string;
    const categories = JSON.parse(categoriesRaw); // [{ category_id: 1, name: 'Premium', price: '300' }, ...]

    const seatLimitMap: Record<string, number> = {Premium: 50, Standard: 100, Economy: 150};

    if (!file || typeof file === 'string') {
      console.warn('[UPLOAD] No file received or file image is a string:', file);
      return NextResponse.json({ success: false, message: 'Invalid image' });
    }

    //Check for duplicate event title
    const [existing]: any = await db.execute(
      'SELECT event_id FROM Event WHERE title = ?',
      [title]
    );
    if (existing.length > 0) {
      return NextResponse.json(
        { success: false, message: 'Event title already exists' },
        { status: 400 }
      );
    }

    // Set maximum file size to 5MB 
    const MAX_SIZE = 5 * 1024 * 1024; 
    // Check image file size
    if (file.size > MAX_SIZE) {
      console.warn(`[UPLOAD] File size too large: ${file.size} bytes`);
      return NextResponse.json(
        { success: false, message: 'File size too large'},
        { status: 400 }
      )
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Validate image file type
    const fileType = await fileTypeFromBuffer(buffer);
    if (!fileType || !fileType.mime.startsWith('image/')) {
      console.warn('[UPLOAD] Rejected non-image file:', fileType);
      return NextResponse.json(
        { success: false, message: 'Invalid file type'},
        { status: 400 }
      )
    }

    const allowTypes = ['image/jpg','image/jpeg', 'image/png', 'image/webp'];
    if (!allowTypes.includes(fileType.mime)) {
      console.warn('[UPLOAD] Unsupported image format:', fileType.mime);
      return NextResponse.json(
        { success: false, message: 'Unsupported file format'},
        { status: 400 }
      )
    }

    // Re-encode image to strip metadata
    const safeImageBuffer = await sharp(buffer).toBuffer();

    // Generate a unique filename with extension
    const fileName = `${uuidv4()}.${fileType.ext}`;
    const uploadDir = path.join(process.cwd(), 'uploads');
    const filePath = path.join(uploadDir, fileName);

    try {
      await fs.mkdir(uploadDir, { recursive: true });
      await fs.writeFile(filePath, safeImageBuffer);
      console.log('File saved successfully');
    } catch (e) {
      console.error('Failed to write file:', e);
      return NextResponse.json(
        { success: false, message: 'File write failed' },
        { status: 500 }
      );
    }

    // Construct the public URL path
    const imageUrl = fileName;

    // Insert into Event table
    const [eventInsertResult]: any = await db.execute(
      'INSERT INTO Event (title, picture, description, location, created_at) VALUES (?, ?, ?, ?, NOW())',
      [title, imageUrl, description, location]
    );

    const eventId = eventInsertResult.insertId;

    // Insert pricing for each category in SeatCategory table
    for (const category of categories) {
      const seatLimit = seatLimitMap[category.name] || 0; // fallback to 0 if unknown
      await db.execute(
        'INSERT INTO SeatCategory (event_id, name, price, seat_limit) VALUES (?, ?, ?, ?)',
        [eventId, category.name, category.price, seatLimit]
      );
    }      

    // Insert each date into EventDate table
    for (const { event_date, start_time, end_time } of dates) {
      await db.execute(
        'INSERT INTO EventDate (event_id, event_date, start_time, end_time) VALUES (?, ?, ?, ?)',
        [eventId, event_date, start_time, end_time]
      );
    }

    // Insert the available seats 
    const [seatCategories] = await db.execute(
      'SELECT seat_category_id, seat_limit FROM SeatCategory WHERE event_id = ?', [eventId]
    ) as [Array<{ seat_category_id: number; seat_limit: number }>, any];
    const [eventDates] = await db.execute(
      'SELECT event_date_id FROM EventDate WHERE event_id = ?', [eventId]
    )as [Array<{ event_date_id: number }>, any];

    for (const category of seatCategories) {
      for (const date of eventDates) {
        await db.execute(
          'INSERT INTO AvailableSeats (seat_category_id, event_date_id, available_seats) VALUES (?, ?, ?)',
          [category.seat_category_id, date.event_date_id, category.seat_limit]
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Event insert error:', err);
    return NextResponse.json({ success: false, message: 'Server error inserting event' }, { status: 500 });
  }
}

// Gets all of events and displays
export async function GET(request: Request) {
  // Check for header 'x-requested-with'
  if (!request.headers.get('x-requested-with')) {
    const host = request.headers.get('host');
    const protocol = request.headers.get('x-forwarded-proto') || 'https';
    const url = `${protocol}://${host}/forbidden`
    return NextResponse.redirect(url);
  }

  try {
    const [rows] = await db.execute(`
      SELECT 
        e.event_id,
        e.title,
        e.picture,
        e.description,
        e.location,
        e.created_at,
        MIN(sc.price) AS lowest_price
      FROM Event e
      LEFT JOIN SeatCategory sc ON sc.event_id = e.event_id
      GROUP BY 
        e.event_id,
        e.title,
        e.picture,
        e.description,
        e.location,
        e.created_at
      ORDER BY e.created_at DESC;
    `);

    const events = (rows as any[]).map((event) => ({
      ...event,
      picture: event.picture, 
    }));

    return NextResponse.json({ success: true, events });
  } catch (err) {
    return NextResponse.json({ success: false, message: 'Failed to fetch events' }, { status: 500 });
  }
}
