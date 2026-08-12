import { NextRequest, NextResponse } from 'next/server';
import { getLogs } from '@/lib/db/operations';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const component = searchParams.get('component') || undefined;
    const level = searchParams.get('level') || undefined;

    const logs = await getLogs(limit, component, level);
    return NextResponse.json({ success: true, data: logs });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
