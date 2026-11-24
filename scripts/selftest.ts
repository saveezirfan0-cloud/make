// End-to-end engine self-test. Runs the bundled sample blueprint against a
// mocked shop API and a mocked Airtable, then asserts the writes.
// Usage: npm run selftest  (after npm run generate-sample)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBlueprint } from '../lib/engine';
import { evalExpression, evalTemplate } from '../lib/engine/expressions';
import { assertPublicUrl, isBlockedAddress } from '../lib/engine/netguard';
import type { Blueprint, Scope } from '../lib/engine/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail)?.slice(0, 400) : '');
  }
}

// ---------------------------------------------------------------------------
console.log('\n[1] Expression evaluator');

const scope: Scope = {
  outputs: {
    '3': { data: { Data: [{ customercode: 'C1' }] } },
    '5': {
      orderdate: '2026-09-03T00:00:00',
      notes: { 'Gift Message': 'Happy birthday!', Comments: 'Leave at the door' },
      totals: [{ Subtotal: '180', Shipping: '12' }],
      categories: [{ code: 'KIT', description: 'Kitchen' }, { code: 'GRD', description: 'Garden' }],
    },
    '6': { id: '' },
    '23': { Orders: ['recAAA', 'recBBB'] },
    '134': { cid: 'recNEW' },
  },
  vars: {},
  variables: { SHOP_API_TOKEN: 'tok_123' },
  feeders: {},
};

check('module path', evalExpression('3.data.Data', scope) !== undefined);
check('backtick key', evalExpression('5.notes.`Gift Message`', scope) === 'Happy birthday!');
check('array [] mapping single', evalExpression('5.totals[].Subtotal', scope) === '180');
check('array [] mapping join', evalExpression('5.categories[].description', scope) === 'Kitchen, Garden');
check('var reference', evalExpression('var.SHOP_API_TOKEN', scope) === 'tok_123');
check('formatDate', evalExpression('formatDate(5.orderdate; "MM/DD/YYYY")', scope) === '09/03/2026');
check('formatDate DD-MM-YYYY input', evalExpression('formatDate("27-08-2026"; "MM/DD/YYYY")', scope) === '08/27/2026');
check('ifempty picks fallback', evalExpression('ifempty(6.id; 134.cid)', scope) === 'recNEW');
check(
  'template mixed string',
  evalTemplate("{Customer Code} = '{{3.data.Data[].customercode}}'", scope) === "{Customer Code} = 'C1'",
);

const surgery = evalExpression(
  'replace(replace(replace(replace(toString(23.Orders); ","; "\\",\\""); "["; "\\""); "]"; "\\""); "\\",\\"" + space; "," + newline)',
  scope,
);
check('linked-record string surgery yields JSON fragment', surgery === '"recAAA","recBBB"', surgery);
check('fragment parses inside JSON array', (() => {
  try {
    return Array.isArray(JSON.parse(`[${surgery}, "recNEW"]`));
  } catch {
    return false;
  }
})());

// ---------------------------------------------------------------------------
console.log('\n[1b] Network guard');

for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
  check(`blocks ${ip}`, isBlockedAddress(ip));
}
for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
  check(`allows ${ip}`, !isBlockedAddress(ip));
}

// ---------------------------------------------------------------------------
console.log('\n[2] Mocked end-to-end run of the sample blueprint');

const blueprint: Blueprint = JSON.parse(
  readFileSync(join(__dirname, '..', 'public', 'samples', 'orders-sync.json'), 'utf8'),
);

const BASE_ID = 'appTESTBASE000001';

interface Call {
  method: string;
  url: string;
  body?: unknown;
}
const calls: Call[] = [];
const orderLinksOnCategory: string[] = ['recOLD001'];

// Airtable paths carry the table name URL-encoded.
const tablePath = (name: string) => `v0/${BASE_ID}/${encodeURIComponent(name)}`;

const realFetch = globalThis.fetch;
// @ts-expect-error test stub
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  let body: unknown;
  if (init?.body) {
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = String(init.body);
    }
  }
  calls.push({ method, url, body });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  // --- Fictional shop API
  if (url.startsWith('https://shop.example.com/')) {
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth !== 'Bearer test-shop-token') return json({ error: 'unauthorized' }, 401);
    return json({
      Data: [
        {
          customercode: 'CUST-001',
          customername: 'Test Customer',
          signupdate: '01-02-2024',
          segment: 'Retail',
          country: 'United Kingdom',
          phone: '+440000000000',
          email: 'customer@example.com',
          city: 'Testville',
          orders: [
            {
              ordernumber: 'SO-1001',
              orderdate: '2026-09-03',
              salesrep: 'Rep One',
              channel: 'Online',
              storename: 'Example Store',
              deliverydate: '',
              notes: { 'Gift Message': 'Enjoy', Comments: 'Leave at the door' },
              totals: [{ Subtotal: '180', Items: '3', Shipping: '12', Tax: '36' }],
              categories: [
                { code: 'KIT', description: 'Kitchen', type: 'Primary' },
                { code: 'GRD', description: 'Garden', type: 'Secondary' },
              ],
              lines: [
                { sku: 'SKU-1', quantity: '5', unitprice: '10' },
                { sku: 'SKU-2', quantity: '7', unitprice: '14' },
              ],
              addons: [
                {
                  'Gift Wrap': [{ code: 'GW-1' }],
                  Warranty: [{ code: 'WR-1' }],
                },
              ],
            },
          ],
        },
      ],
    });
  }

  // --- Airtable
  if (url.startsWith('https://api.airtable.com/')) {
    const path = url.slice('https://api.airtable.com/'.length);
    // searches
    if (method === 'GET') {
      if (path.startsWith(tablePath('Customers'))) return json({ records: [] }); // new customer -> create path
      if (path.startsWith(tablePath('Categories'))) {
        // category lookup: found, with existing order links
        return json({
          records: [
            {
              id: 'recCAT0001',
              createdTime: '2026-01-01T00:00:00.000Z',
              fields: { Code: 'KIT', Orders: orderLinksOnCategory },
            },
          ],
        });
      }
      if (path.startsWith(tablePath('Products'))) return json({ records: [] }); // products not found
      if (path.startsWith(tablePath('Add-ons'))) {
        return json({
          records: [{ id: 'recADDON01', createdTime: '2026-01-01T00:00:00.000Z', fields: { Code: 'GW-1' } }],
        });
      }
      return json({ records: [] });
    }
    if (method === 'POST') {
      const id = path.startsWith(tablePath('Customers'))
        ? 'recCUSTOMER1'
        : path.startsWith(tablePath('Orders'))
          ? 'recORDER0001'
          : 'recNEW0001';
      return json({ id, createdTime: new Date().toISOString(), fields: (body as { fields?: object })?.fields ?? {} });
    }
    if (method === 'PATCH') {
      const id = decodeURIComponent(path.split('/')[3] ?? '').split('?')[0];
      return json({ id, createdTime: new Date().toISOString(), fields: (body as { fields?: object })?.fields ?? {} });
    }
  }
  return json({ error: `unmocked ${method} ${url}` }, 500);
};

(async () => {
  const rejects = async (url: string) => assertPublicUrl(url).then(() => false, () => true);
  check('rejects http://localhost', await rejects('http://localhost:3000/'));
  check('rejects cloud metadata IP', await rejects('http://169.254.169.254/latest/meta-data/'));
  check('rejects file: URLs', await rejects('file:///etc/passwd'));
  check('rejects IPv6 loopback literal', await rejects('http://[::1]/'));

  const result = await runBlueprint(blueprint, {
    variables: { SHOP_API_TOKEN: 'test-shop-token', AIRTABLE_BASE_ID: BASE_ID },
    connections: { '1001': { type: 'airtable', token: 'pat_test' } },
  });

  globalThis.fetch = realFetch;

  check('run finished without fatal error', result.ok, result.error);
  check('executed a healthy number of ops', result.ops > 10, result.ops);

  const find = (m: string, urlPart: string) => calls.filter((c) => c.method === m && c.url.includes(urlPart));

  check('called the shop API once', find('POST', 'shop.example.com').length === 1);
  const customerCreate = find('POST', tablePath('Customers'));
  check('created customer record (new customer path)', customerCreate.length === 1);
  check(
    'customer create mapped code + name',
    JSON.stringify(customerCreate[0]?.body).includes('CUST-001') &&
      JSON.stringify(customerCreate[0]?.body).includes('Test Customer'),
    customerCreate[0]?.body,
  );

  const customerUpdate = calls.filter((c) => c.method === 'PATCH' && c.url.includes(`${tablePath('Customers')}/recCUSTOMER1`));
  check('updated customer using captured cid variable', customerUpdate.length === 1);

  const orderCreate = find('POST', tablePath('Orders'));
  check('created order', orderCreate.length === 1);
  check(
    'order linked to customer + joined category descriptions',
    JSON.stringify(orderCreate[0]?.body).includes('recCUSTOMER1') &&
      JSON.stringify(orderCreate[0]?.body).includes('Kitchen, Garden'),
    orderCreate[0]?.body,
  );

  const catPatch = calls.filter((c) => c.method === 'PATCH' && c.url.includes(`${tablePath('Categories')}/recCAT0001`));
  check('category linked back to order (append path)', catPatch.length >= 1);
  const catLinks = (catPatch[0]?.body as { fields?: Record<string, unknown> })?.fields?.Orders;
  check(
    'append preserved existing links and added new order id',
    Array.isArray(catLinks) && catLinks.includes('recOLD001') && catLinks.includes('recORDER0001'),
    catLinks,
  );

  const mainCatPatch = calls.filter(
    (c) =>
      c.method === 'PATCH' &&
      c.url.includes(`${tablePath('Orders')}/recORDER0001`) &&
      JSON.stringify(c.body).includes('Main Category'),
  );
  check('main category written (filtered route)', mainCatPatch.length === 1, mainCatPatch[0]?.body);
  check(
    'main category is KIT only (Secondary filtered out)',
    JSON.stringify(mainCatPatch[0]?.body ?? {}).includes('KIT') && mainCatPatch.length === 1,
  );

  const qtyPatch = calls.filter((c) => c.method === 'PATCH' && JSON.stringify(c.body).includes('Quantities'));
  check(
    'quantities aggregated across order lines ("5, 7")',
    JSON.stringify(qtyPatch[0]?.body ?? {}).includes('5, 7'),
    qtyPatch[0]?.body,
  );

  const addonPatch = calls.filter((c) => c.method === 'PATCH' && c.url.includes(`${tablePath('Add-ons')}/recADDON01`));
  check('add-on (Gift Wrap) linked to order', addonPatch.length >= 1);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) {
    console.log('\n--- run log ---');
    for (const e of (await Promise.resolve(result)).log) {
      console.log(`${e.seq} [${e.moduleId}] ${e.name} ${e.status} ${e.summary ?? ''} ${e.error ?? ''}`);
    }
    process.exit(1);
  }
})();
