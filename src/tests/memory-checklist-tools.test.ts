import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addChecklistItemTool,
  archiveChecklistTool,
  createChecklistTool,
  listChecklistsTool,
  moveChecklistItemTool,
  updateChecklistItemTool,
} from '../tools/memory-checklist-tools.js';
import { setupMemoryToolTest } from './helpers/memory-tool-test-setup.js';

type TreeItem = { id: string; title: string; parentId?: string; ordinal?: number; children: TreeItem[] };
function findInTree(items: TreeItem[], title: string): TreeItem | undefined {
  for (const item of items) {
    if (item.title === title) return item;
    const found = findInTree(item.children, title);
    if (found) return found;
  }
  return undefined;
}

test('memory checklist tools trust boundary: missing eventId is rejected', async () => {
  const { cleanup } = setupMemoryToolTest();
  try {
    await assert.rejects(
      createChecklistTool.execute({ eventId: 'missing-event-id', title: 't', slug: 's' } as never),
      /trusted eventId/,
    );
  } finally {
    cleanup();
  }
});

test('create_checklist + add_checklist_item + list_checklists round-trip through the trusted event scope', async () => {
  const { event, cleanup } = setupMemoryToolTest({ projectId: 'proj-cl' });
  try {
    const created = JSON.parse(
      await createChecklistTool.execute({ eventId: event.id, title: 'Phase 0', slug: 'phase-0', items: [{ title: 'Schemas' }] }),
    ) as { checklist: { id: string; items: { id: string; title: string }[] } };
    const checklistId = created.checklist.id;
    const firstItemId = created.checklist.items[0].id;

    const withChild = JSON.parse(
      await addChecklistItemTool.execute({ eventId: event.id, checklistId, parentId: firstItemId, title: 'Nested' }),
    ) as { checklist: { items: { id: string; title: string; parentId?: string; children: unknown[] }[] } };
    const nested = findInTree(withChild.checklist.items as TreeItem[], 'Nested');
    assert.ok(nested, 'rendered tree contains the nested item');
    assert.equal(nested?.parentId, firstItemId);

    const moved = JSON.parse(
      await moveChecklistItemTool.execute({ eventId: event.id, checklistId, itemId: nested?.id ?? '', ordinal: 5 }),
    ) as { checklist: { items: TreeItem[] } };
    assert.ok(findInTree(moved.checklist.items, 'Nested'), 'moved item still present');

    const archived = JSON.parse(await archiveChecklistTool.execute({ eventId: event.id, id: checklistId })) as {
      checklist: { status: string };
    };
    assert.equal(archived.checklist.status, 'archived');

    const listed = JSON.parse(await listChecklistsTool.execute({ eventId: event.id, includeArchived: true })) as {
      checklists: { id: string }[];
    };
    assert.ok(listed.checklists.some((c) => c.id === checklistId));

    // Default list (excludeArchived) should not include the archived checklist.
    const activeListed = JSON.parse(await listChecklistsTool.execute({ eventId: event.id })) as {
      checklists: { id: string; status: string }[];
    };
    assert.ok(!activeListed.checklists.some((c) => c.id === checklistId));
  } finally {
    cleanup();
  }
});

test('update_checklist_item changes item status', async () => {
  const { event, cleanup } = setupMemoryToolTest({ projectId: 'proj-cl2' });
  try {
    const created = JSON.parse(
      await createChecklistTool.execute({ eventId: event.id, title: 'CL', slug: 'cl', items: [{ title: 'A' }] }),
    ) as { checklist: { id: string; items: { id: string }[] } };
    const updated = JSON.parse(
      await updateChecklistItemTool.execute({
        eventId: event.id,
        checklistId: created.checklist.id,
        itemId: created.checklist.items[0].id,
        status: 'completed',
      }),
    ) as { checklist: { items: { status: string }[] } };
    assert.equal(updated.checklist.items[0].status, 'completed');
  } finally {
    cleanup();
  }
});
