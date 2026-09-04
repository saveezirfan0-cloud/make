// Generates public/samples/medical-records-sync.json — the bundled sample
// scenario (UniteCare -> Airtable medical-records sync), slimmed to the
// fields the engine executes. Secrets are referenced as {{var.*}}; the
// original hardcoded bearer token is NOT included.
//
// Run: npm run generate-sample

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'app7QJ2pvhADHQeBP';
const T_UNITE = 'tbl9856qJP9S7OEqB';
const T_MRD = 'tblllKPKIY9qvMoEU';
const T_DIAGNOSIS = 'tblZqf4Zcw5Kweadh';
const T_MEDICATION = 'tblLM2BXjA680GQws';
const T_ITEMS = 'tblTJtk6aIMbwpoA2';
const CONN = 10209480;

const F_MRD_LINK_ON_DIAGNOSIS = 'fldhZEmogfSr6ImNV';
const F_MRD_LINK_ON_MEDICATION = 'fldpryRGaMe7cCqkd';
const F_MRD_LINK_ON_ITEMS = 'fld8rbMC3zSkDqC8J';

const at = (id, action, mapper, extra = {}) => ({
  id,
  module: `airtable:${action}`,
  version: 3,
  parameters: { __IMTCONN__: CONN },
  mapper,
  ...extra,
});

const designer = (name) => ({ metadata: { designer: { name } } });

// Make-style string surgery that turns a linked-record array into a quoted,
// comma-separated JSON fragment (kept verbatim from the original scenario).
const mrDataExpr = (searchId) =>
  `{{replace(replace(replace(replace(toString(${searchId}.\`Medical Records Data\`); ","; "\\",\\""); "["; "\\""); "]"; "\\""); "\\",\\"" + space; "," + newline)}}`;

const patchLink = (id, table, linkField, recordIdExpr, arrayBody, filter) => ({
  id,
  module: 'airtable:makeApiCall',
  version: 3,
  parameters: { __IMTCONN__: CONN },
  filter,
  mapper: {
    url: `v0/${BASE}/${table}/${recordIdExpr}`,
    method: 'PATCH',
    headers: [{ key: 'Content-Type', value: 'application/json' }],
    body: `{\n  "fields": {\n    "${linkField}": [\n      ${arrayBody}\n    ]\n  }\n}`,
  },
});

/**
 * The repeated "link a looked-up record back to the active MRD" motif:
 *   search by code -> if found:
 *     - MRD links already exist and don't contain ours -> PATCH append
 *     - no MRD links yet -> PATCH fresh
 */
function linkbackRouter({ searchId, setVarId, appendId, freshId, table, linkField }) {
  return {
    id: searchId + 1,
    module: 'builtin:BasicRouter',
    version: 1,
    filter: { name: '', conditions: [[{ a: `{{${searchId}.id}}`, o: 'exist' }]] },
    mapper: null,
    routes: [
      {
        flow: [
          {
            id: setVarId,
            module: 'util:SetVariable2',
            version: 1,
            parameters: {},
            filter: {
              name: '',
              conditions: [[{ a: `{{${searchId}.\`Medical Records Data\`}}`, o: 'exist' }]],
            },
            mapper: { name: 'name', scope: 'roundtrip', value: mrDataExpr(searchId) },
          },
          patchLink(
            appendId,
            table,
            linkField,
            `{{${searchId}.id}}`,
            `{{${setVarId}.name}},\n      "{{16.activeMrdId}}"`,
            {
              name: '',
              conditions: [[{ a: `{{${setVarId}.name}}`, b: '{{16.activeMrdId}}', o: 'text:notcontain' }]],
            },
          ),
        ],
      },
      {
        flow: [
          patchLink(freshId, table, linkField, `{{${searchId}.id}}`, `"{{16.activeMrdId}}"`, {
            name: '',
            conditions: [[{ a: `{{${searchId}.\`Medical Records Data\`}}`, o: 'notexist' }]],
          }),
        ],
      },
    ],
  };
}

/** One item-category route: feeder -> search Items by code -> linkback. */
function itemCategoryRoute(categoryKey, feederId) {
  const searchId = feederId + 1;
  return {
    flow: [
      {
        id: feederId,
        module: 'builtin:BasicFeeder',
        version: 1,
        parameters: {},
        mapper: { array: `{{39.\`${categoryKey}\`}}` },
        ...designer(`Iterate ${categoryKey}`),
      },
      at(
        searchId,
        'ActionSearchRecords',
        {
          base: BASE,
          table: T_ITEMS,
          formula: `{Code} = '{{${feederId}.code}}'`,
          maxRecords: '10',
          useColumnId: false,
        },
        {
          filter: { name: '', conditions: [[{ a: `{{${feederId}.code}}`, o: 'exist' }]] },
          ...designer(`Find item (${categoryKey})`),
        },
      ),
      linkbackRouter({
        searchId,
        setVarId: searchId + 2,
        appendId: searchId + 3,
        freshId: searchId + 4,
        table: T_ITEMS,
        linkField: F_MRD_LINK_ON_ITEMS,
      }),
    ],
  };
}

const blueprint = {
  name: 'UniteCare → Airtable medical records sync',
  subflows: [
    {
      flow: [
        {
          id: 3,
          module: 'http:ActionSendData',
          version: 3,
          parameters: { handleErrors: true, useNewZLibDeCompress: true },
          mapper: {
            ca: '',
            qs: [],
            url: 'https://ucexternalapiprod.uniteuae.care/gateway/GetMedicalRecordsDetails',
            data: '{\n"from_date": "{{formatDate(addDays(now(); -7); "DD-MM-YYYY")}}",\n"to_date": "{{formatDate(now(); "DD-MM-YYYY")}}"\n}',
            gzip: true,
            method: 'post',
            headers: [
              { name: 'Content-type', value: 'application/json' },
              { name: 'Authorization', value: 'Bearer {{var.UNITE_API_TOKEN}}' },
            ],
            timeout: '',
            bodyType: 'raw',
            contentType: 'application/json',
            parseResponse: true,
            followRedirect: true,
            rejectUnauthorized: true,
          },
          ...designer('Get Appointments'),
        },
        {
          id: 4,
          module: 'builtin:BasicFeeder',
          version: 1,
          parameters: {},
          mapper: { array: '{{3.data.Data}}' },
          ...designer('Iterate patients'),
        },
        {
          id: 5,
          module: 'builtin:BasicFeeder',
          version: 1,
          parameters: {},
          mapper: { array: '{{4.visitdetails}}' },
          ...designer('Iterate visits'),
        },
        at(
          6,
          'ActionSearchRecords',
          {
            base: BASE,
            table: T_UNITE,
            formula: "{Patient Pin} = '{{4.patientpin}}'",
            maxRecords: '10',
            useColumnId: false,
          },
          designer('Find patient'),
        ),
        {
          id: 123,
          module: 'builtin:BasicIfElse',
          version: 1,
          mapper: null,
          branches: [
            {
              merge: true,
              disabled: false,
              label: 'Existing patient',
              type: 'condition',
              conditions: [[{ a: '{{6.id}}', o: 'exist' }]],
              flow: [
                at(
                  7,
                  'ActionSearchRecords',
                  {
                    base: BASE,
                    table: T_MRD,
                    formula:
                      "AND(\n  ARRAYJOIN({Patient Pin (from Unite)}) = '{{4.patientpin}}',\n  DATETIME_FORMAT({Visit Date}, 'MM/DD/YYYY') = '{{formatDate(5.visitdate; \"MM/DD/YYYY\")}}',\n  {Doctor Name} = '{{5.doctorname}}'\n)",
                    maxRecords: '1',
                    useColumnId: false,
                  },
                  designer('Find existing MRD'),
                ),
              ],
            },
            {
              merge: true,
              disabled: false,
              label: 'New patient, no MRD yet',
              type: 'condition',
              conditions: [[{ a: '{{6.id}}', o: 'notexist' }]],
              flow: [
                at(
                  9,
                  'ActionCreateRecord',
                  {
                    base: BASE,
                    table: T_UNITE,
                    record: {
                      fld0rZhF2bjTxyiNS: '{{5.doctorname}}',
                      fld1Zt1g7IGjk2mOX: '{{formatDate(4.dateofbirth; "MM/DD/YYYY")}}',
                      fldGW2uKUvJ8Go98Q: '{{4.patientpin}}',
                      fldHk1eGk61Hqr3yB: '{{5.department}}',
                      fldWCINbQSFZUrBBd: '{{4.nationality}}',
                      fldXgsBUYTP2xvUv1: '{{4.gender}}',
                      fldZHFmhmfL6INxWR: '{{4.visitdate}}',
                      fldcF6Tlh1q8SYNsI: '{{4.patientname}}',
                      flddF5X0a7DtDJRNf: '{{4.mobilephone}}',
                      fldgSGQs00acVQccE: '{{5.followupvisit}}',
                      fldikPNTGpc52GqOW: '{{4.mailid}}',
                      fldluzXiKHaK4RfaW: '{{4.city}}',
                      fldsA7v4aGIVzv0S8: '{{5.clinicname}}',
                      fldwTnnvCipJeVvco: '{{5.visitdate}}',
                    },
                    typecast: false,
                    useColumnId: true,
                  },
                  designer('Create patient'),
                ),
                {
                  id: 135,
                  module: 'util:SetVariable2',
                  version: 1,
                  parameters: {},
                  filter: null,
                  mapper: { name: 'pid', scope: 'roundtrip', value: '{{9.id}}' },
                  ...designer('Capture new patient id'),
                },
              ],
            },
            {
              merge: true,
              disabled: false,
              label: '',
              type: 'else',
              flow: [{ id: 124, module: 'placeholder:Placeholder' }],
            },
          ],
        },
        {
          id: 129,
          module: 'builtin:BasicMerge',
          version: 1,
          // Only continue when no MRD exists yet for this exact visit.
          filter: { name: 'No existing MRD', conditions: [[{ a: '{{7.id}}', o: 'notexist' }]] },
          mapper: null,
          ...designer('Merge · stop if visit already recorded'),
        },
        {
          id: 134,
          module: 'util:GetVariables',
          version: 1,
          parameters: {},
          filter: null,
          mapper: { variables: ['mrid', 'pid'] },
          ...designer('Get variables'),
        },
        at(
          11,
          'ActionUpdateRecords',
          {
            id: '{{ifempty(6.id; 134.pid)}}',
            base: BASE,
            table: T_UNITE,
            record: {
              fld0rZhF2bjTxyiNS: '{{5.doctorname}}',
              fldHk1eGk61Hqr3yB: '{{5.department}}',
              fldgSGQs00acVQccE: '{{5.followupvisit}}',
              fldsA7v4aGIVzv0S8: '{{5.clinicname}}',
              fldwTnnvCipJeVvco: '{{formatDate(5.visitdate; "MM/DD/YYYY")}}',
            },
            typecast: false,
            useColumnId: true,
          },
          {
            filter: {
              name: 'Patient record resolved',
              conditions: [
                [{ a: '{{6.id}}', o: 'exist' }],
                [{ a: '{{134.pid}}', o: 'exist' }],
              ],
            },
            ...designer('Update patient last visit'),
          },
        ),
        at(
          13,
          'ActionCreateRecord',
          {
            base: BASE,
            table: T_MRD,
            record: {
              fld5ONgPlFlyJFZYy: '{{5.notes.`Doctor Notes`}}',
              fld5eftp6BVHSyPQd: '{{5.diagnosis[].description}}',
              fldFzXAhtt2fcRTDy: '{{5.vitals[].`O2 % BldC Oximetry`}}',
              fldJQiC2fplhNXa1N: '{{5.notes.`History Of Present Illness`}}',
              fldJajCqvONmaX3XL: '{{5.vitals[].Height}}',
              fldKuI5eXoDJIiOcu: '{{formatDate(5.visitdate; "MM/DD/YYYY")}}',
              fldOVaKPQc3VUwJnh: '{{5.vitals[].Pulse}}',
              fldQEoJfTLKODHoq7: '{{5.vitals[].`BP Systolic`}}',
              fldQWA9jjupL6EF3L: '{{5.vitals[].`Body Temperature`}}',
              fldUGZGwjklowwHJI: '{{5.notes.`Review Of Systems`}}',
              fldVWIrd7336dmS6x: '{{5.notes.`Procedure Notes `}}',
              fldX8Chw8INeRhuTD: '{{5.notes.`Nurse Notes`}}',
              fldZiy0HG9KGApOtc: '{{5.doctorname}}',
              fldZsPHI9BBzWWgap: '{{5.notes.Complaints}}',
              fldhDyDyi1V5soDiO: '{{5.notes.`Plan of Treatment`}}',
              fldpNQHsUjrA9XG8a: '{{5.notes.`Observations/Physical Examination`}}',
              fldtMJzbQovI9IliR: '{{11.fldcF6Tlh1q8SYNsI}}',
              fldtxNjAanspw8h40: ['{{11.id}}'],
              fldx5AdhYb49W946I: '{{5.notes.`Therapy Notes`}}',
              fldz0AtfcKuYy52FV: '{{5.vitals[].`BP Diastolic`}}',
              fldzdjzBPCdvG9U8U: '{{5.vitals[].`Weight Measured`}}',
            },
            typecast: false,
            useColumnId: true,
          },
          designer('Create medical record'),
        ),
        {
          id: 16,
          module: 'util:SetVariable2',
          version: 1,
          parameters: {},
          mapper: { name: 'activeMrdId', scope: 'roundtrip', value: '{{13.id}}' },
          ...designer('Capture MRD id'),
        },
        {
          id: 21,
          module: 'builtin:BasicRouter',
          version: 1,
          filter: { name: '', conditions: [[{ a: '{{16.activeMrdId}}', o: 'exist' }]] },
          mapper: null,
          routes: [
            // ---- Diagnosis ------------------------------------------------
            {
              flow: [
                {
                  id: 22,
                  module: 'builtin:BasicFeeder',
                  version: 1,
                  parameters: {},
                  mapper: { array: '{{5.diagnosis}}' },
                  ...designer('Iterate diagnosis'),
                },
                {
                  id: 136,
                  module: 'builtin:BasicRouter',
                  version: 1,
                  filter: null,
                  mapper: null,
                  routes: [
                    {
                      flow: [
                        at(
                          23,
                          'ActionSearchRecords',
                          {
                            base: BASE,
                            table: T_DIAGNOSIS,
                            formula: "{Code} = '{{22.code}}'",
                            maxRecords: '10',
                            useColumnId: false,
                          },
                          designer('Find diagnosis'),
                        ),
                        linkbackRouter({
                          searchId: 23,
                          setVarId: 25,
                          appendId: 26,
                          freshId: 27,
                          table: T_DIAGNOSIS,
                          linkField: F_MRD_LINK_ON_DIAGNOSIS,
                        }),
                      ],
                    },
                    {
                      flow: [
                        at(
                          137,
                          'ActionUpdateRecords',
                          {
                            id: '{{13.id}}',
                            base: BASE,
                            table: T_MRD,
                            record: { fldSIH4uHnviEYYel: '{{22.code}}' },
                            typecast: false,
                            useColumnId: true,
                          },
                          {
                            filter: {
                              name: 'Primary diagnosis',
                              conditions: [[{ a: '{{22.type}}', b: 'Primary', o: 'text:equal' }]],
                            },
                            ...designer('Set primary diagnosis'),
                          },
                        ),
                      ],
                    },
                  ],
                },
              ],
            },
            // ---- Medication ----------------------------------------------
            {
              flow: [
                {
                  id: 28,
                  module: 'builtin:BasicFeeder',
                  version: 1,
                  parameters: {},
                  mapper: { array: '{{5.medication}}' },
                  ...designer('Iterate medication'),
                },
                {
                  id: 29,
                  module: 'builtin:BasicRouter',
                  version: 1,
                  mapper: null,
                  routes: [
                    {
                      flow: [
                        at(
                          30,
                          'ActionSearchRecords',
                          {
                            base: BASE,
                            table: T_MEDICATION,
                            formula: "{DDC Code} = '{{28.localcode}}'",
                            maxRecords: '10',
                            useColumnId: false,
                          },
                          designer('Find medication'),
                        ),
                        linkbackRouter({
                          searchId: 30,
                          setVarId: 32,
                          appendId: 33,
                          freshId: 34,
                          table: T_MEDICATION,
                          linkField: F_MRD_LINK_ON_MEDICATION,
                        }),
                      ],
                    },
                    {
                      flow: [
                        {
                          id: 35,
                          module: 'util:TextAggregator',
                          version: 1,
                          parameters: { feeder: 28, rowSeparator: 'other', otherRowSeparator: ', ' },
                          mapper: { value: '{{28.dosagedays}}' },
                          ...designer('Aggregate dosage days'),
                        },
                        at(
                          36,
                          'upsertRecord',
                          {
                            base: BASE,
                            table: T_MRD,
                            record: { fldw8Oyu3hhgAS3gV: '{{35.text}}' },
                            recordId: '{{16.activeMrdId}}',
                            typecast: false,
                            useColumnId: true,
                          },
                          designer('Save dosage days'),
                        ),
                      ],
                    },
                    {
                      flow: [
                        {
                          id: 37,
                          module: 'util:TextAggregator',
                          version: 1,
                          parameters: { feeder: 28, rowSeparator: 'other', otherRowSeparator: ', ' },
                          mapper: { value: '{{28.totalquantity}}' },
                          ...designer('Aggregate quantities'),
                        },
                        at(
                          38,
                          'upsertRecord',
                          {
                            base: BASE,
                            table: T_MRD,
                            record: { fld2m2sHEXFI3hCvl: '{{37.text}}' },
                            recordId: '{{16.activeMrdId}}',
                            typecast: false,
                            useColumnId: true,
                          },
                          designer('Save quantities'),
                        ),
                      ],
                    },
                  ],
                },
              ],
            },
            // ---- Items (procedures, labs, drugs, ...) --------------------
            {
              flow: [
                {
                  id: 39,
                  module: 'builtin:BasicFeeder',
                  version: 1,
                  parameters: {},
                  mapper: { array: '{{5.items}}' },
                  ...designer('Iterate item groups'),
                },
                {
                  id: 40,
                  module: 'builtin:BasicRouter',
                  version: 1,
                  mapper: null,
                  routes: [
                    itemCategoryRoute('Procedure', 41),
                    itemCategoryRoute('Investigations', 47),
                    itemCategoryRoute('Radiology', 53),
                    itemCategoryRoute('Intravenous Therapy', 59),
                    itemCategoryRoute('Drugs', 65),
                    itemCategoryRoute('Vaccine', 71),
                    itemCategoryRoute('Other Services', 77),
                    itemCategoryRoute('Retail Product', 83),
                    itemCategoryRoute('Dental Procedures', 89),
                    itemCategoryRoute('Home Healthcare', 95),
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  metadata: { version: 1 },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, '..', 'public', 'samples', 'medical-records-sync.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(blueprint, null, 2) + '\n');
console.log(`Wrote ${outPath}`);
