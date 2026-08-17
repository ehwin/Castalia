/**
 * Memory Category Manager
 * Hierarchical categories inspired by SynaBun
 */
import { DatabaseManager } from './db.js';

export interface Category {
  name: string;
  description: string;
  parent: string | null;
  color: string | null;
  isParent: boolean;
  children?: Category[];
}

export function listCategories(): Category[] {
  const db = DatabaseManager.getInstance();
  const rows = db.prepare('SELECT * FROM categories ORDER BY parent, name').all() as any[];
  return rows.map(r => ({
    name: r.name,
    description: r.description,
    parent: r.parent,
    color: r.color,
    isParent: r.is_parent === 1,
  }));
}

export function getCategoryTree(): Record<string, Category> {
  const categories = listCategories();
  const tree: Record<string, Category> = {};

  for (const cat of categories) {
    if (cat.isParent || !cat.parent) {
      tree[cat.name] = { ...cat, children: [] };
    }
  }

  for (const cat of categories) {
    if (cat.parent && tree[cat.parent]) {
      tree[cat.parent].children!.push(cat);
    }
  }

  return tree;
}

export function createCategory(name: string, description: string, parent?: string, color?: string): Category {
  const db = DatabaseManager.getInstance();
  
  // Validate name format
  if (!/^[a-z][a-z0-9-]*$/.test(name) || name.length < 2 || name.length > 30) {
    throw new Error('Category name must be lowercase, start with a letter, 2-30 chars, letters/digits/hyphens only');
  }

  // Check if exists
  const existing = db.prepare('SELECT name FROM categories WHERE name = ?').get(name);
  if (existing) throw new Error(`Category "${name}" already exists`);

  // Check parent exists
  if (parent) {
    const parentExists = db.prepare('SELECT name FROM categories WHERE name = ?').get(parent);
    if (!parentExists) throw new Error(`Parent category "${parent}" does not exist`);
  }

  db.prepare(`
    INSERT INTO categories (name, description, parent, color, is_parent)
    VALUES (?, ?, ?, ?, 0)
  `).run(name, description, parent || null, color || null);

  return { name, description, parent: parent || null, color: color || null, isParent: false };
}

export function deleteCategory(name: string, reassignTo?: string, reassignChildrenTo?: string): { reassigned: number } {
  const db = DatabaseManager.getInstance();

  const cat = db.prepare('SELECT * FROM categories WHERE name = ?').get(name) as any;
  if (!cat) throw new Error(`Category "${name}" not found`);

  // Check for children
  const children = db.prepare('SELECT name FROM categories WHERE parent = ?').all(name) as any[];
  if (children.length > 0 && !reassignChildrenTo) {
    throw new Error(`Cannot delete "${name}": has children [${children.map(c => c.name).join(', ')}]. Provide reassignChildrenTo.`);
  }

  // Check for memories
  const memCount = db.prepare('SELECT COUNT(*) as cnt FROM memory WHERE category = ? AND is_active = 1').get(name) as { cnt: number };
  if (memCount.cnt > 0 && !reassignTo) {
    throw new Error(`Cannot delete "${name}": ${memCount.cnt} memories use it. Provide reassignTo.`);
  }

  const tx = db.transaction(() => {
    // Reassign children
    if (children.length > 0 && reassignChildrenTo) {
      db.prepare('UPDATE categories SET parent = ? WHERE parent = ?').run(reassignChildrenTo, name);
    }

    // Reassign memories
    if (memCount.cnt > 0 && reassignTo) {
      db.prepare('UPDATE memory SET category = ? WHERE category = ?').run(reassignTo, name);
    }

    // Delete category
    db.prepare('DELETE FROM categories WHERE name = ?').run(name);
  });

  tx();
  return { reassigned: memCount.cnt };
}
