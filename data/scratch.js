
const fs = require('fs');
const OPENAI_REQ = {
  model: 'default',
  messages: [
    { role: 'user', content: 'test tool' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'test_call', type: 'function', function: { name: 'remember', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'test_call', content: 'result' }
  ],
  tools: [{ type: 'function', function: { name: 'remember', description: 'test' } }]
};

fetch('http://127.0.0.1:4315/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' },
  body: JSON.stringify(OPENAI_REQ)
}).then(r => r.text().then(t => console.log('Status:', r.status, 'Body:', t)));
