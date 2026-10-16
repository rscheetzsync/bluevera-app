
 // BlueVera sold-history database connection test.
// Deploy: api/armls-sold-db-write-test.js
// POST only. Requires an approved Supabase admin session.
// Inserts one SYNTHETIC row, reads it back, then deletes it.
// No Spark calls and no real MLS data.

import { randomUUID } from 'node:crypto';

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8'
};

const norm = x =>
  String(x ?? '').trim().toLowerCase();

async function getAdmin(req, base, key) {
  const match = /^Bearer\s+(\S+)$/i.exec(
    String(req.headers.authorization || '')
  );

  if (!match) {
    return {
      status: 401,
      error: 'Sign in to BlueVera admin first.'
    };
  }

  const identity = await fetch(
    `${base}/auth/v1/user`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${match[1]}`
      },
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!identity.ok) {
    return {
      status: 401,
      error: 'Admin session expired. Sign in again.'
    };
  }

  const user = await identity.json();

  if (!user?.id || !user?.email) {
    return {
      status: 401,
      error: 'Invalid admin identity.'
    };
  }

  const search = new URLSearchParams({
    select: 'email,role,is_active',
    is_active: 'eq.true',
    limit: '100'
  });

  const response = await fetch(
    `${base}/rest/v1/admin_users?${search}`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`
      },
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    return {
      status: 503,
      error:
        `Admin lookup failed (HTTP ${response.status}).`
    };
  }

  const rows = await response.json();

  const approved =
    Array.isArray(rows) &&
    rows.some(row =>
      row.is_active === true &&
      norm(row.email) === norm(user.email) &&
      ['admin', 'super_admin'].includes(
        norm(row.role)
      )
    );

  return approved
    ? { ok: true }
    : {
        status: 403,
        error: 'Approved admin access required.'
      };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  res.setHeader('Allow', 'POST');

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'POST only.'
    });
  }

  const base = String(
    process.env.SUPABASE_URL || ''
  ).replace(/\/$/, '');

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!base || !key) {
    return res.status(503).json({
      success: false,
      error: 'Supabase server configuration missing.'
    });
  }

  try {
    const admin = await getAdmin(
      req,
      base,
      key
    );

    if (!admin.ok) {
      return res.status(admin.status).json({
        success: false,
        error: admin.error
      });
    }
  } catch (err) {
    return res.status(503).json({
      success: false,
      error: 'Could not verify admin session.'
    });
  }

  const mls =
    `BVTEST${randomUUID()
      .replaceAll('-', '')
      .slice(0, 16)
      .toUpperCase()}`;

  const table =
    `${base}/rest/v1/armls_sold_properties`;

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...jsonHeaders
  };

  const filter =
    `mls_number=eq.${encodeURIComponent(mls)}`;

  let inserted = false;
  let stage = 'insert';
  let result = null;
  let failure = null;
  let cleaned = false;
  let cleanupError = null;

  try {
    // STEP 1: INSERT SYNTHETIC RECORD

    const put = await fetch(table, {
      method: 'POST',

      headers: {
        ...headers,
        Prefer: 'return=representation'
      },

      body: JSON.stringify({
        mls_number: mls,
        property_address:
          '123 BlueVera Synthetic Test Street',
        city: 'Phoenix',
        state: 'AZ',
        zip_code: '85003',
        sold_date: '2025-06-15',
        sold_price: 450000,
        listing_status: 'Closed',
        roof: 'Full',
        roof_year: 2023,
        hvac: 'Partial',
        hvac_year: 2024,

        raw_armls_data: {
          synthetic: true,
          source: 'BlueVera connectivity test'
        }
      }),

      signal: AbortSignal.timeout(15000)
    });

    const insertedRows = await put.json()
      .catch(() => null);

    if (
      !put.ok ||
      !Array.isArray(insertedRows) ||
      insertedRows.length !== 1
    ) {
      throw new Error(
        `Insert failed (HTTP ${put.status}): ${
          insertedRows?.message ||
          'Unexpected response'
        }`
      );
    }

    inserted = true;

    // STEP 2: READ BACK THE RECORD

    stage = 'read';

    const read = await fetch(
      `${table}?select=mls_number,zip_code,sold_date,sold_price,roof_year,hvac_year,raw_armls_data&${filter}`,
      {
        headers,
        signal: AbortSignal.timeout(15000)
      }
    );

    const found = await read.json()
      .catch(() => null);

    if (
      !read.ok ||
      !Array.isArray(found) ||
      found.length !== 1 ||
      found[0].mls_number !== mls ||
      Number(found[0].sold_price) !== 450000 ||
      found[0].raw_armls_data?.synthetic !== true
    ) {
      throw new Error(
        `Read-back verification failed (HTTP ${read.status}).`
      );
    }

    result = {
      inserted: true,
      readBackVerified: true
    };

  } catch (err) {
    failure =
      err?.message ||
      'Unexpected database error.';

  } finally {
    // STEP 3: DELETE SYNTHETIC RECORD
    // Only delete this test's generated MLS number.

    if (inserted) {
      try {
        stage = 'delete';

        const del = await fetch(
          `${table}?${filter}`,
          {
            method: 'DELETE',

            headers: {
              ...headers,
              Prefer: 'return=representation'
            },

            signal: AbortSignal.timeout(15000)
          }
        );

        const deleted = await del.json()
          .catch(() => null);

        if (
          !del.ok ||
          !Array.isArray(deleted) ||
          deleted.length !== 1
        ) {
          throw new Error(
            `Delete failed (HTTP ${del.status}).`
          );
        }

        cleaned = true;

      } catch (err) {
        cleanupError =
          err?.message ||
          'Cleanup failed.';
      }
    }
  }

  const success =
    !!result &&
    cleaned &&
    !failure;

  return res.status(success ? 200 : 500).json({
    success,

    mode:
      'SYNTHETIC_SUPABASE_WRITE_READ_DELETE',

    sparkCalled: false,

    testMls: mls,

    inserted,

    readBackVerified:
      !!result?.readBackVerified,

    deleted: cleaned,

    error:
      failure ||
      cleanupError ||
      null,

    note: cleaned
      ? 'Synthetic test record removed.'
      : inserted
        ? 'Cleanup incomplete: use testMls to locate and remove only the synthetic record.'
        : 'No record was inserted.'
  });
}
