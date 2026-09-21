import type { Brain } from '../server/app.js';
export function askFixture(brain: Brain) {
  const a = brain.memories.save({
    title: 'FORGELINE enterprise homelab',
    type: 'project',
    status: 'active',
    project_state: 'active',
    project: 'FORGELINE',
    body: 'FORGELINE is your enterprise homelab for practicing identity, networking and resilient infrastructure.',
  });
  const direction = brain.memories.save({
    title: 'FORGELINE direction',
    project: 'FORGELINE',
    body: 'FORGELINE is focused on domain isolation and repeatable recovery.',
  });
  const b = brain.memories.save({
    title: 'AWS Architecture',
    type: 'project',
    status: 'completed',
    project: 'AWS Architecture',
    body: 'This is a multi-AZ infrastructure project. You plan a resilient deployment with automated failover.',
    facts: [{ key: 'aws.deployed', value: 'true' }],
  });
  const c = brain.memories.save({
    title: 'ELPSY portfolio',
    type: 'project',
    status: 'completed',
    project: 'ELPSY',
    body: 'This is your portfolio website project and the visual identity work.',
  });
  const hardware = brain.memories.save({
    title: 'Your hardware configuration',
    body: 'This is your desktop computer: Ryzen 9 9950X, 64 GB RAM and an RTX 5080.',
  });
  const price = brain.memories.save({
    title: 'Graphics purchasing policy',
    type: 'policy',
    body: 'This is your graphics purchasing preference.',
    facts: [{ key: 'gpu.test.max_price', value: '1450 EUR' }],
  });
  const future = brain.memories.save({
    title: 'Robot arm project idea',
    type: 'idea',
    status: 'inbox',
    body: 'This is a future robotic arm project idea. A motor has not been chosen.',
  });
  const goal = brain.memories.save({
    title: 'Current technical goal',
    type: 'goal',
    body: 'Your current technical goal is to deepen identity and networking knowledge through FORGELINE.',
  });
  const unrelated = ['Mneme app notes', 'Bread recipe', 'Travel plans', 'Music list', 'Garden routine'].map(
    (title) =>
      brain.memories.save({
        title,
        body: `This is your ${title.toLowerCase()}. It is active and is a personal note.`,
        importance: 1,
      }),
  );
  brain.graph.link({ from_id: a.id, to_id: unrelated[0].id, type: 'related_to' });
  return { a, direction, b, c, hardware, price, future, goal, unrelated };
}
