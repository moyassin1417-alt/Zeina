/**
 * بيت زينة — المساعد الذكي (Cloudflare Worker proxy)
 *
 * الهدف: يحمي مفتاح Claude API (ما يتخزنش جوه ملف التطبيق نفسه اللي ظاهر للكل)،
 * ويوصل بين التطبيق وClaude، وهو اللي بيقرر هل الرسالة سؤال (يرد بنص عادي)
 * ولا طلب إضافة بيانات (يرجّع tool_calls عشان التطبيق ينفذها محليًا).
 *
 * الإعداد (مرة واحدة على dash.cloudflare.com):
 *  1) Workers & Pages -> Create -> Create Worker -> الصق الكود ده كامل.
 *  2) من Settings -> Variables and Secrets ضيف اتنين Secrets:
 *       ANTHROPIC_API_KEY   = مفتاحك من https://console.anthropic.com/settings/keys
 *       APP_SHARED_SECRET   = أي كلمة سر تخترعها انت (استخدمها بعدين في إعدادات المساعد جوه التطبيق)
 *  3) Deploy، وانسخ رابط الـ Worker (…workers.dev) وحطه في إعدادات المساعد جوه التطبيق.
 *
 * ملحوظة أمان: الـ APP_SHARED_SECRET مش حماية قوية 100% (أي كود بيتبعت من المتصفح
 * أصلاً ممكن يتشاف)، لكنه بيمنع أي حد عشوائي يلاقي رابط الـ Worker بالصدفة ويستهلك
 * رصيدك على Claude API. لو حابب حماية أقوى، تقدر تضيف rate limiting لاحقًا.
 */

const ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 1024;

// نفس تصنيفات المصاريف الموجودة في التطبيق (لازم تتزامن يدويًا لو ضفت/غيرت تصنيف هناك)
const EXPENSE_CATEGORIES = [
  'bills','selfcare','transport','groceries','debts','dining','installments',
  'subscriptions','zeina','advances','jamiyat','rent','education','travel',
  'health','shopping','admin','kids','fun','other'
];
// ملحوظة: "liability_payment" و"savings" مستثناة عمدًا — دول تصنيفات مرتبطة بعمليات
// خاصة (سداد التزام / مساهمة هدف ادخار) والمساعد مسموح له بس بالإضافة المباشرة.

const TOOLS = [
  {
    name: 'add_expense',
    description: 'إضافة مصروف جديد لهذا الشهر (لا يُستخدم لسداد التزام ولا للمساهمة في هدف ادخار — لهم أدوات خاصة).',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'المبلغ بالريال السعودي، رقم موجب' },
        category: { type: 'string', enum: EXPENSE_CATEGORIES, description: 'مفتاح التصنيف الأنسب' },
        name: { type: 'string', description: 'وصف مختصر للمصروف (اختياري)' },
        user: { type: 'string', enum: ['بابا','ماما'], description: 'صاحب المصروف، لو معروف من الكلام' }
      },
      required: ['amount','category']
    }
  },
  {
    name: 'add_liability',
    description: 'إضافة التزام مالي جديد (قرض، تمويل، دين...).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'اسم الالتزام' },
        value: { type: 'number', description: 'القيمة المتبقية بالريال، رقم موجب' }
      },
      required: ['name','value']
    }
  },
  {
    name: 'add_asset',
    description: 'إضافة أصل شخصي جديد (سيارة، عقار، أثاث...) — غير الذهب، له أداة منفصلة.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'اسم الأصل' },
        value: { type: 'number', description: 'القيمة التقديرية بالريال، رقم موجب' }
      },
      required: ['name','value']
    }
  },
  {
    name: 'add_gold_item',
    description: 'إضافة قطعة ذهب جديدة (بالوزن بالجرام — القيمة بتتحسب تلقائيًا من سعر الذهب اليومي في التطبيق).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'وصف القطعة (خاتم، سوار...)' },
        weight_grams: { type: 'number', description: 'الوزن بالجرام، رقم موجب' }
      },
      required: ['name','weight_grams']
    }
  },
  {
    name: 'add_goal',
    description: 'إضافة هدف ادخار جديد (عمرة، صندوق زينة...) برصيد ابتدائي صفر.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'اسم الهدف' },
        target: { type: 'number', description: 'المبلغ المستهدف بالريال، رقم موجب' }
      },
      required: ['name','target']
    }
  },
  {
    name: 'contribute_to_goal',
    description: 'إضافة مبلغ (مساهمة) لهدف ادخار موجود بالفعل — بيزود رصيد الهدف وبيتسجل تلقائيًا كمصروف "ادخار" في ميزانية الشهر. المبلغ لازم يكون موجب فقط (سحب/تعديل رصيد الهدف مش متاح من هنا).',
    input_schema: {
      type: 'object',
      properties: {
        goal_name: { type: 'string', description: 'اسم الهدف كما هو موجود (أو أقرب تطابق)' },
        amount: { type: 'number', description: 'المبلغ المضاف، رقم موجب' }
      },
      required: ['goal_name','amount']
    }
  },
  {
    name: 'add_recurring',
    description: 'إضافة مصروف ثابت شهري جديد (قالب متكرر) — إيجار، اشتراك...',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'اسم المصروف الثابت' },
        amount: { type: 'number', description: 'المبلغ الشهري بالريال، رقم موجب' },
        category: { type: 'string', enum: EXPENSE_CATEGORIES, description: 'مفتاح التصنيف الأنسب' }
      },
      required: ['name','amount','category']
    }
  }
];

function corsHeaders(origin){
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, origin){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

function buildSystemPrompt(state){
  return `انت "مساعد بيت زينة" — مساعد مالي عائلي بيتكلم عربي بس، جوه تطبيق ميزانية أسرة سعودية (بابا وماما).
مهمتك اتنين بس:
1) تجاوب على أي سؤال عن البيانات المالية للأسرة (الميزانية، المصاريف، الالتزامات، الأصول، الذهب، أهداف الادخار) بالاعتماد فقط على البيانات المرفقة تحت — من غير ما تخترع أرقام.
2) لو المستخدم طلب "يضيف" حاجة جديدة (مصروف، التزام، أصل، قطعة ذهب، هدف ادخار، مساهمة في هدف، مصروف ثابت) — استخدم الأداة (tool) المناسبة.

قواعد مهمة:
- انت تقدر "تضيف" بس — مفيش عندك أي أداة للتعديل أو الحذف أو السحب. لو حد طلب يعدّل أو يحذف أو يسحب حاجة، اعتذر بلطف واقترح يستخدم الأزرار في التطبيق مباشرة.
- كل الأرقام بالريال السعودي.
- لو المبلغ أو التفاصيل ناقصة أو غامضة، اسأل سؤال توضيحي قصير بدل ما تخمن.
- ردودك تكون قصيرة ومباشرة ومفيدة، من غير حشو.
- التاريخ النهاردة: ${state.today}. الشهر المعروض حاليًا في التطبيق: ${state.currentMonth}.

بيانات الأسرة الحالية (JSON):
${JSON.stringify(state)}`;
}

export default {
  async fetch(request, env){
    const origin = request.headers.get('Origin') || '*';

    if(request.method === 'OPTIONS'){
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if(request.method !== 'POST'){
      return json({ error: 'method_not_allowed' }, 405, origin);
    }

    const token = request.headers.get('X-App-Token') || '';
    if(!env.APP_SHARED_SECRET || token !== env.APP_SHARED_SECRET){
      return json({ error: 'unauthorized' }, 401, origin);
    }
    if(!env.ANTHROPIC_API_KEY){
      return json({ error: 'server_misconfigured', message: 'ANTHROPIC_API_KEY لم يُضبط على الـ Worker' }, 500, origin);
    }

    let body;
    try{
      body = await request.json();
    } catch(e){
      return json({ error: 'bad_request' }, 400, origin);
    }

    const message = (body && body.message || '').toString().slice(0, 2000);
    const history = Array.isArray(body && body.history) ? body.history.slice(-20) : [];
    const state = (body && body.state) || {};
    if(!message) return json({ error: 'empty_message' }, 400, origin);

    const messages = history
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content }))
      .concat([{ role: 'user', content: message }]);

    let anthropicRes;
    try{
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: MAX_TOKENS,
          system: buildSystemPrompt(state),
          messages,
          tools: TOOLS
        })
      });
    } catch(e){
      return json({ error: 'upstream_unreachable' }, 502, origin);
    }

    if(!anthropicRes.ok){
      let detail = '';
      try{ detail = await anthropicRes.text(); }catch(e){}
      return json({ error: 'upstream_error', status: anthropicRes.status, detail: detail.slice(0,500) }, 502, origin);
    }

    const data = await anthropicRes.json();
    const content = Array.isArray(data.content) ? data.content : [];
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const toolCalls = content.filter(b => b.type === 'tool_use').map(b => ({ name: b.name, input: b.input }));

    return json({ text, tool_calls: toolCalls }, 200, origin);
  }
};
