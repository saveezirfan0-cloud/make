// End-to-end engine self-test. Runs the bundled sample blueprint against a
// mocked UniteCare API and a mocked Airtable, then asserts the writes.
// Usage: npm run selftest  (after npm run generate-sample)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBlueprint } from '../lib/engine';
import { evalExpression, evalTemplate } from '../lib/engine/expressions';
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
    '3': { data: { Data: [{ patientpin: 'P1' }] } },
    '5': {
      visitdate: '2026-09-03T00:00:00',
      notes: { 'Doctor Notes': 'note!', Complaints: 'cough' },
      vitals: [{ Height: '180', 'BP Systolic': '120' }],
      diagnosis: [{ code: 'J06.9', description: 'URI' }, { code: 'R05', description: 'Cough' }],
    },
    '6': { id: '' },
    '23': { 'Medical Records Data': ['recAAA', 'recBBB'] },
    '134': { pid: 'recNEW' },
  },
  vars: {},
  variables: { UNITE_API_TOKEN: 'tok_123' },
  feeders: {},
};

check('module path', evalExpression('3.data.Data', scope) !== undefined);
check('backtick key', evalExpression('5.notes.`Doctor Notes`', scope) === 'note!');
check('array [] mapping single', evalExpression('5.vitals[].Height', scope) === '180');
check('array [] mapping join', evalExpression('5.diagnosis[].description', scope) === 'URI, Cough');
check('var reference', evalExpression('var.UNITE_API_TOKEN', scope) === 'tok_123');
check('formatDate', evalExpression('formatDate(5.visitdate; "MM/DD/YYYY")', scope) === '09/03/2026');
check('formatDate DD-MM-YYYY input', evalExpression('formatDate("27-08-2026"; "MM/DD/YYYY")', scope) === '08/27/2026');
check('ifempty picks fallback', evalExpression('ifempty(6.id; 134.pid)', scope) === 'recNEW');
check(
  'template mixed string',
  evalTemplate("{Patient Pin} = '{{3.data.Data[].patientpin}}'", scope) === "{Patient Pin} = 'P1'",
);

const surgery = evalExpression(
  'replace(replace(replace(replace(toString(23.`Medical Records Data`); ","; "\\",\\""); "["; "\\""); "]"; "\\""); "\\",\\"" + space; "," + newline)',
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
console.log('\n[2] Mocked end-to-end run of the sample blueprint');

const blueprint: Blueprint = JSON.parse(
  readFileSync(join(__dirname, '..', 'public', 'samples', 'medical-records-sync.json'), 'utf8'),
);

interface Call {
  method: string;
  url: string;
  body?: unknown;
}
const calls: Call[] = [];
let mrdLinksOnDiagnosis: string[] = ['recOLD001'];

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

  // --- UniteCare API
  if (url.includes('uniteuae.care')) {
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth !== 'Bearer test-unite-token') return json({ error: 'unauthorized' }, 401);
    return json({
      Data: [
        {
          patientpin: 'PIN-001',
          patientname: 'Test Patient',
          dateofbirth: '01-02-1990',
          gender: 'F',
          nationality: 'United Kingdom',
          mobilephone: '+9715550000',
          mailid: 'p@example.com',
          city: 'Dubai',
          visitdate: '2026-09-03',
          visitdetails: [
            {
              visitdate: '2026-09-03',
              doctorname: 'Dr. Test',
              department: 'General',
              clinicname: 'Al Das Medical Clinic - Meadows',
              followupvisit: '',
              notes: { 'Doctor Notes': 'All good', Complaints: 'Cough' },
              vitals: [{ Height: '180', Pulse: '72', 'BP Systolic': '120', 'BP Diastolic': '80' }],
              diagnosis: [
                { code: 'J06.9', description: 'Acute URI', type: 'Primary' },
                { code: 'R05', description: 'Cough', type: 'Secondary' },
              ],
              medication: [
                { localcode: 'MED-1', dosagedays: '5', totalquantity: '10' },
                { localcode: 'MED-2', dosagedays: '7', totalquantity: '14' },
              ],
              items: [
                {
                  Procedure: [{ code: 'PROC-1' }],
                  Investigations: [{ code: 'INV-1' }],
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
      if (path.includes('tbl9856qJP9S7OEqB')) return json({ records: [] }); // patient not found -> create path
      if (path.includes('tblZqf4Zcw5Kweadh')) {
        // diagnosis lookup: found, with existing MRD links
        return json({
          records: [
            {
              id: 'recDIAG01',
              createdTime: '2026-01-01T00:00:00.000Z',
              fields: { Code: 'J06.9', 'Medical Records Data': mrdLinksOnDiagnosis },
            },
          ],
        });
      }
      if (path.includes('tblLM2BXjA680GQws')) return json({ records: [] }); // meds not found
      if (path.includes('tblTJtk6aIMbwpoA2')) {
        return json({
          records: [{ id: 'recITEM01', createdTime: '2026-01-01T00:00:00.000Z', fields: { Code: 'PROC-1' } }],
        });
      }
      return json({ records: [] });
    }
    if (method === 'POST') {
      const table = path.split('/')[2]?.split('?')[0];
      const id =
        table === 'tbl9856qJP9S7OEqB' ? 'recPATIENT1' : table === 'tblllKPKIY9qvMoEU' ? 'recMRD0001' : 'recNEW0001';
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
  const result = await runBlueprint(blueprint, {
    variables: { UNITE_API_TOKEN: 'test-unite-token' },
    connections: { '10209480': { type: 'airtable', token: 'pat_test' } },
  });

  globalThis.fetch = realFetch;

  check('run finished without fatal error', result.ok, result.error);
  check('executed a healthy number of ops', result.ops > 10, result.ops);

  const find = (m: string, urlPart: string) => calls.filter((c) => c.method === m && c.url.includes(urlPart));

  check('called UniteCare API once', find('POST', 'uniteuae.care').length === 1);
  const patientCreate = find('POST', 'tbl9856qJP9S7OEqB');
  check('created patient record (new patient path)', patientCreate.length === 1);
  check(
    'patient create mapped pin + name',
    JSON.stringify(patientCreate[0]?.body).includes('PIN-001') &&
      JSON.stringify(patientCreate[0]?.body).includes('Test Patient'),
    patientCreate[0]?.body,
  );

  const patientUpdate = calls.filter((c) => c.method === 'PATCH' && c.url.includes('tbl9856qJP9S7OEqB/recPATIENT1'));
  check('updated patient using captured pid variable', patientUpdate.length === 1);

  const mrdCreate = find('POST', 'tblllKPKIY9qvMoEU');
  check('created medical record', mrdCreate.length === 1);
  check(
    'MRD linked to patient + joined diagnosis descriptions',
    JSON.stringify(mrdCreate[0]?.body).includes('recPATIENT1') &&
      JSON.stringify(mrdCreate[0]?.body).includes('Acute URI, Cough'),
    mrdCreate[0]?.body,
  );

  const diagPatch = calls.filter((c) => c.method === 'PATCH' && c.url.includes('tblZqf4Zcw5Kweadh/recDIAG01'));
  check('diagnosis linked back to MRD (append path)', diagPatch.length >= 1);
  const diagLinks = (diagPatch[0]?.body as { fields?: Record<string, unknown> })?.fields?.fldhZEmogfSr6ImNV;
  check(
    'append preserved existing links and added new MRD id',
    Array.isArray(diagLinks) && diagLinks.includes('recOLD001') && diagLinks.includes('recMRD0001'),
    diagLinks,
  );

  const primaryPatch = calls.filter(
    (c) => c.method === 'PATCH' && c.url.includes('tblllKPKIY9qvMoEU/recMRD0001') && JSON.stringify(c.body).includes('fldSIH4uHnviEYYel'),
  );
  check('primary diagnosis code written (filtered route)', primaryPatch.length === 1, primaryPatch[0]?.body);
  check(
    'primary diagnosis is J06.9 only (Secondary filtered out)',
    JSON.stringify(primaryPatch[0]?.body ?? {}).includes('J06.9') && primaryPatch.length === 1,
  );

  const dosagePatch = calls.filter(
    (c) => c.method === 'PATCH' && JSON.stringify(c.body).includes('fldw8Oyu3hhgAS3gV'),
  );
  check(
    'dosage days aggregated across medication bundles ("5, 7")',
    JSON.stringify(dosagePatch[0]?.body ?? {}).includes('5, 7'),
    dosagePatch[0]?.body,
  );

  const itemPatch = calls.filter((c) => c.method === 'PATCH' && c.url.includes('tblTJtk6aIMbwpoA2/recITEM01'));
  check('item (Procedure) linked to MRD', itemPatch.length >= 1);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) {
    console.log('\n--- run log ---');
    for (const e of (await Promise.resolve(result)).log) {
      console.log(`${e.seq} [${e.moduleId}] ${e.name} ${e.status} ${e.summary ?? ''} ${e.error ?? ''}`);
    }
    process.exit(1);
  }
})();
