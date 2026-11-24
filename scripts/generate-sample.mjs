// Generates public/samples/orders-sync.json, the bundled sample scenario: a
// made-up web shop's orders pulled from an API into Airtable. Every name, URL
// and ID in it is fictional. The shop API lives on example.com (reserved for
// documentation), and the Airtable base comes from {{var.AIRTABLE_BASE_ID}},
// so the scenario can be pointed at a base of your own.
//
// It exercises the same engine features as a real scenario: HTTP with a token
// variable and date maths, nested iterators, Airtable search/create/update/
// upsert and raw API calls, if/else with merge, routers, filters, variables
// and a text aggregator.
//
// Run: npm run generate-sample

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = '{{var.AIRTABLE_BASE_ID}}';
const T_CUSTOMERS = 'Customers';
const T_ORDERS = 'Orders';
const T_CATEGORIES = 'Categories';
const T_PRODUCTS = 'Products';
const T_ADDONS = 'Add-ons';
// A placeholder Make connection id. Map it to your Airtable token under
// Connections, or set an AIRTABLE_TOKEN variable.
const CONN = 1001;

// Linked-record fields that point back to Orders.
const F_ORDERS_LINK = 'Orders';

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
// comma-separated JSON fragment, the way it's often done in Make.
const linkedIdsExpr = (searchId) =>
  `{{replace(replace(replace(replace(toString(${searchId}.\`${F_ORDERS_LINK}\`); ","; "\\",\\""); "["; "\\""); "]"; "\\""); "\\",\\"" + space; "," + newline)}}`;

const patchLink = (id, table, linkField, recordIdExpr, arrayBody, filter) => ({
  id,
  module: 'airtable:makeApiCall',
  version: 3,
  parameters: { __IMTCONN__: CONN },
  filter,
  mapper: {
    url: `v0/${BASE}/${encodeURIComponent(table)}/${recordIdExpr}`,
    method: 'PATCH',
    headers: [{ key: 'Content-Type', value: 'application/json' }],
    body: `{\n  "fields": {\n    "${linkField}": [\n      ${arrayBody}\n    ]\n  }\n}`,
  },
});

/**
 * The repeated "link a looked-up record back to the new order" motif:
 *   search by code -> if found:
 *     - order links already exist and don't contain ours -> PATCH append
 *     - no order links yet -> PATCH fresh
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
              conditions: [[{ a: `{{${searchId}.\`${F_ORDERS_LINK}\`}}`, o: 'exist' }]],
            },
            mapper: { name: 'name', scope: 'roundtrip', value: linkedIdsExpr(searchId) },
          },
          patchLink(
            appendId,
            table,
            linkField,
            `{{${searchId}.id}}`,
            `{{${setVarId}.name}},\n      "{{16.activeOrderId}}"`,
            {
              name: '',
              conditions: [[{ a: `{{${setVarId}.name}}`, b: '{{16.activeOrderId}}', o: 'text:notcontain' }]],
            },
          ),
        ],
      },
      {
        flow: [
          patchLink(freshId, table, linkField, `{{${searchId}.id}}`, `"{{16.activeOrderId}}"`, {
            name: '',
            conditions: [[{ a: `{{${searchId}.\`${F_ORDERS_LINK}\`}}`, o: 'notexist' }]],
          }),
        ],
      },
    ],
  };
}

/** One add-on group route: feeder -> search Add-ons by code -> linkback. */
function addonGroupRoute(groupKey, feederId) {
  const searchId = feederId + 1;
  return {
    flow: [
      {
        id: feederId,
        module: 'builtin:BasicFeeder',
        version: 1,
        parameters: {},
        mapper: { array: `{{39.\`${groupKey}\`}}` },
        ...designer(`Iterate ${groupKey}`),
      },
      at(
        searchId,
        'ActionSearchRecords',
        {
          base: BASE,
          table: T_ADDONS,
          formula: `{Code} = '{{${feederId}.code}}'`,
          maxRecords: '10',
          useColumnId: false,
        },
        {
          filter: { name: '', conditions: [[{ a: `{{${feederId}.code}}`, o: 'exist' }]] },
          ...designer(`Find add-on (${groupKey})`),
        },
      ),
      linkbackRouter({
        searchId,
        setVarId: searchId + 2,
        appendId: searchId + 3,
        freshId: searchId + 4,
        table: T_ADDONS,
        linkField: F_ORDERS_LINK,
      }),
    ],
  };
}

const blueprint = {
  name: 'Sample: web shop orders → Airtable',
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
            url: 'https://shop.example.com/api/orders/search',
            data: '{\n"from_date": "{{formatDate(addDays(now(); -7); "DD-MM-YYYY")}}",\n"to_date": "{{formatDate(now(); "DD-MM-YYYY")}}"\n}',
            gzip: true,
            method: 'post',
            headers: [
              { name: 'Content-type', value: 'application/json' },
              { name: 'Authorization', value: 'Bearer {{var.SHOP_API_TOKEN}}' },
            ],
            timeout: '',
            bodyType: 'raw',
            contentType: 'application/json',
            parseResponse: true,
            followRedirect: true,
            rejectUnauthorized: true,
          },
          ...designer('Get last 7 days of orders'),
        },
        {
          id: 4,
          module: 'builtin:BasicFeeder',
          version: 1,
          parameters: {},
          mapper: { array: '{{3.data.Data}}' },
          ...designer('Iterate customers'),
        },
        {
          id: 5,
          module: 'builtin:BasicFeeder',
          version: 1,
          parameters: {},
          mapper: { array: '{{4.orders}}' },
          ...designer('Iterate orders'),
        },
        at(
          6,
          'ActionSearchRecords',
          {
            base: BASE,
            table: T_CUSTOMERS,
            formula: "{Customer Code} = '{{4.customercode}}'",
            maxRecords: '10',
            useColumnId: false,
          },
          designer('Find customer'),
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
              label: 'Existing customer',
              type: 'condition',
              conditions: [[{ a: '{{6.id}}', o: 'exist' }]],
              flow: [
                at(
                  7,
                  'ActionSearchRecords',
                  {
                    base: BASE,
                    table: T_ORDERS,
                    formula:
                      "AND(\n  ARRAYJOIN({Customer Code (from Customer)}) = '{{4.customercode}}',\n  DATETIME_FORMAT({Order Date}, 'MM/DD/YYYY') = '{{formatDate(5.orderdate; \"MM/DD/YYYY\")}}',\n  {Order Number} = '{{5.ordernumber}}'\n)",
                    maxRecords: '1',
                    useColumnId: false,
                  },
                  designer('Find existing order'),
                ),
              ],
            },
            {
              merge: true,
              disabled: false,
              label: 'New customer, no orders yet',
              type: 'condition',
              conditions: [[{ a: '{{6.id}}', o: 'notexist' }]],
              flow: [
                at(
                  9,
                  'ActionCreateRecord',
                  {
                    base: BASE,
                    table: T_CUSTOMERS,
                    record: {
                      'Customer Code': '{{4.customercode}}',
                      'Customer Name': '{{4.customername}}',
                      Email: '{{4.email}}',
                      Phone: '{{4.phone}}',
                      City: '{{4.city}}',
                      Country: '{{4.country}}',
                      Segment: '{{4.segment}}',
                      'Signup Date': '{{formatDate(4.signupdate; "MM/DD/YYYY")}}',
                      'Sales Rep': '{{5.salesrep}}',
                      Channel: '{{5.channel}}',
                      Store: '{{5.storename}}',
                      'Last Order Date': '{{5.orderdate}}',
                      'Next Delivery': '{{5.deliverydate}}',
                    },
                    typecast: false,
                    useColumnId: false,
                  },
                  designer('Create customer'),
                ),
                {
                  id: 135,
                  module: 'util:SetVariable2',
                  version: 1,
                  parameters: {},
                  filter: null,
                  mapper: { name: 'cid', scope: 'roundtrip', value: '{{9.id}}' },
                  ...designer('Capture new customer id'),
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
          // Only continue when this order isn't in Airtable yet.
          filter: { name: 'Order not recorded yet', conditions: [[{ a: '{{7.id}}', o: 'notexist' }]] },
          mapper: null,
          ...designer('Merge · stop if order already recorded'),
        },
        {
          id: 134,
          module: 'util:GetVariables',
          version: 1,
          parameters: {},
          filter: null,
          mapper: { variables: ['oid', 'cid'] },
          ...designer('Get variables'),
        },
        at(
          11,
          'ActionUpdateRecords',
          {
            id: '{{ifempty(6.id; 134.cid)}}',
            base: BASE,
            table: T_CUSTOMERS,
            record: {
              'Sales Rep': '{{5.salesrep}}',
              Channel: '{{5.channel}}',
              'Next Delivery': '{{5.deliverydate}}',
              Store: '{{5.storename}}',
              'Last Order Date': '{{formatDate(5.orderdate; "MM/DD/YYYY")}}',
            },
            typecast: false,
            useColumnId: false,
          },
          {
            filter: {
              name: 'Customer record resolved',
              conditions: [
                [{ a: '{{6.id}}', o: 'exist' }],
                [{ a: '{{134.cid}}', o: 'exist' }],
              ],
            },
            ...designer('Update customer last order'),
          },
        ),
        at(
          13,
          'ActionCreateRecord',
          {
            base: BASE,
            table: T_ORDERS,
            record: {
              'Order Number': '{{5.ordernumber}}',
              'Order Date': '{{formatDate(5.orderdate; "MM/DD/YYYY")}}',
              Customer: ['{{11.id}}'],
              'Customer Name': '{{11.`Customer Name`}}',
              'Sales Rep': '{{5.salesrep}}',
              Categories: '{{5.categories[].description}}',
              Subtotal: '{{5.totals[].Subtotal}}',
              'Discount %': '{{5.totals[].`Discount %`}}',
              Shipping: '{{5.totals[].Shipping}}',
              Tax: '{{5.totals[].Tax}}',
              'Item Count': '{{5.totals[].Items}}',
              'Weight kg': '{{5.totals[].`Weight kg`}}',
              'Gift Message': '{{5.notes.`Gift Message`}}',
              'Delivery Instructions': '{{5.notes.`Delivery Instructions`}}',
              'Customer Comments': '{{5.notes.Comments}}',
              'Packing Notes': '{{5.notes.`Packing Notes`}}',
            },
            typecast: false,
            useColumnId: false,
          },
          designer('Create order'),
        ),
        {
          id: 16,
          module: 'util:SetVariable2',
          version: 1,
          parameters: {},
          mapper: { name: 'activeOrderId', scope: 'roundtrip', value: '{{13.id}}' },
          ...designer('Capture order id'),
        },
        {
          id: 21,
          module: 'builtin:BasicRouter',
          version: 1,
          filter: { name: '', conditions: [[{ a: '{{16.activeOrderId}}', o: 'exist' }]] },
          mapper: null,
          routes: [
            // ---- Categories -----------------------------------------------
            {
              flow: [
                {
                  id: 22,
                  module: 'builtin:BasicFeeder',
                  version: 1,
                  parameters: {},
                  mapper: { array: '{{5.categories}}' },
                  ...designer('Iterate categories'),
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
                            table: T_CATEGORIES,
                            formula: "{Code} = '{{22.code}}'",
                            maxRecords: '10',
                            useColumnId: false,
                          },
                          designer('Find category'),
                        ),
                        linkbackRouter({
                          searchId: 23,
                          setVarId: 25,
                          appendId: 26,
                          freshId: 27,
                          table: T_CATEGORIES,
                          linkField: F_ORDERS_LINK,
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
                            table: T_ORDERS,
                            record: { 'Main Category': '{{22.code}}' },
                            typecast: false,
                            useColumnId: false,
                          },
                          {
                            filter: {
                              name: 'Main category',
                              conditions: [[{ a: '{{22.type}}', b: 'Primary', o: 'text:equal' }]],
                            },
                            ...designer('Set main category'),
                          },
                        ),
                      ],
                    },
                  ],
                },
              ],
            },
            // ---- Order lines ----------------------------------------------
            {
              flow: [
                {
                  id: 28,
                  module: 'builtin:BasicFeeder',
                  version: 1,
                  parameters: {},
                  mapper: { array: '{{5.lines}}' },
                  ...designer('Iterate order lines'),
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
                            table: T_PRODUCTS,
                            formula: "{SKU} = '{{28.sku}}'",
                            maxRecords: '10',
                            useColumnId: false,
                          },
                          designer('Find product'),
                        ),
                        linkbackRouter({
                          searchId: 30,
                          setVarId: 32,
                          appendId: 33,
                          freshId: 34,
                          table: T_PRODUCTS,
                          linkField: F_ORDERS_LINK,
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
                          mapper: { value: '{{28.quantity}}' },
                          ...designer('Aggregate quantities'),
                        },
                        at(
                          36,
                          'upsertRecord',
                          {
                            base: BASE,
                            table: T_ORDERS,
                            record: { Quantities: '{{35.text}}' },
                            recordId: '{{16.activeOrderId}}',
                            typecast: false,
                            useColumnId: false,
                          },
                          designer('Save quantities'),
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
                          mapper: { value: '{{28.unitprice}}' },
                          ...designer('Aggregate unit prices'),
                        },
                        at(
                          38,
                          'upsertRecord',
                          {
                            base: BASE,
                            table: T_ORDERS,
                            record: { 'Unit Prices': '{{37.text}}' },
                            recordId: '{{16.activeOrderId}}',
                            typecast: false,
                            useColumnId: false,
                          },
                          designer('Save unit prices'),
                        ),
                      ],
                    },
                  ],
                },
              ],
            },
            // ---- Add-ons (gift wrap, warranty, ...) ---------------------
            {
              flow: [
                {
                  id: 39,
                  module: 'builtin:BasicFeeder',
                  version: 1,
                  parameters: {},
                  mapper: { array: '{{5.addons}}' },
                  ...designer('Iterate add-on groups'),
                },
                {
                  id: 40,
                  module: 'builtin:BasicRouter',
                  version: 1,
                  mapper: null,
                  routes: [
                    addonGroupRoute('Gift Wrap', 41),
                    addonGroupRoute('Warranty', 47),
                    addonGroupRoute('Accessories', 53),
                    addonGroupRoute('Installation', 59),
                    addonGroupRoute('Subscription', 65),
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
const outPath = join(__dirname, '..', 'public', 'samples', 'orders-sync.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(blueprint, null, 2) + '\n');
console.log(`Wrote ${outPath}`);
