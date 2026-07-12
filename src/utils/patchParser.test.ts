import { parseApplyPatch } from './patchParser';

describe('parseApplyPatch', () => {
  it('should parse a patch with Add, Update, and Delete operations', () => {
    const patch = `*** Begin Patch
*** Add File: new.txt
+hello
+world
*** Delete File: old.txt
*** Update File: edit.txt
@@ fn main
 context
-remove me
+add me
*** End Patch`;

    const result = parseApplyPatch(patch);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      totalFiles: 3,
      totalAdded: 3,
      totalRemoved: 1,
    });

    const files = result!.files;
    expect(files).toHaveLength(3);

    // Add
    expect(files[0]).toMatchObject({
      type: 'add',
      filePath: 'new.txt',
      addedLines: 2,
      removedLines: 0,
      oldContent: '',
      newContent: 'hello\nworld',
    });

    // Delete
    expect(files[1]).toMatchObject({
      type: 'delete',
      filePath: 'old.txt',
      addedLines: 0,
      removedLines: 0,
    });

    // Update
    expect(files[2]).toMatchObject({
      type: 'update',
      filePath: 'edit.txt',
      chunkCount: 1,
      addedLines: 1,
      removedLines: 1,
    });
  });

  it('should parse a patch with multiple chunks in Update', () => {
    const patch = `*** Begin Patch
*** Update File: main.ts
@@ top
 context
-old1
+new1
@@ bottom
 context2
-old2
+new2
*** End Patch`;

    const result = parseApplyPatch(patch);
    expect(result).not.toBeNull();

    const file = result!.files[0];
    expect(file).toMatchObject({
      type: 'update',
      filePath: 'main.ts',
      chunkCount: 2,
      addedLines: 2,
      removedLines: 2,
    });

    // oldContent should contain removed + context lines
    expect(file.oldContent).toContain('context');
    expect(file.oldContent).toContain('old1');
    expect(file.oldContent).toContain('context2');
    expect(file.oldContent).toContain('old2');

    // newContent should contain added + context lines
    expect(file.newContent).toContain('context');
    expect(file.newContent).toContain('new1');
    expect(file.newContent).toContain('context2');
    expect(file.newContent).toContain('new2');
  });

  it('should parse a patch with Update + Move to', () => {
    const patch = `*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
@@
 line
*** End Patch`;

    const result = parseApplyPatch(patch);
    expect(result).not.toBeNull();

    const file = result!.files[0];
    expect(file.type).toBe('update');
    expect(file.filePath).toBe('a.txt');
    expect(file.movePath).toBe('b.txt');
  });

  it('should return null for invalid patch without Begin marker', () => {
    const result = parseApplyPatch('*** Delete File: x.txt');
    expect(result).toBeNull();
  });

  it('should return null for empty input', () => {
    expect(parseApplyPatch('')).toBeNull();
    expect(parseApplyPatch(null as unknown as string)).toBeNull();
  });

  it('should handle a patch with multiple Update files', () => {
    const patch = `*** Begin Patch
*** Update File: a.rs
@@
-old
+new
*** Update File: b.rs
@@
-old2
+new2
*** End Patch`;

    const result = parseApplyPatch(patch);
    expect(result).not.toBeNull();
    expect(result!.totalFiles).toBe(2);
    expect(result!.totalAdded).toBe(2);
    expect(result!.totalRemoved).toBe(2);

    expect(result!.files[0].filePath).toBe('a.rs');
    expect(result!.files[1].filePath).toBe('b.rs');
  });

  it('should count added/removed lines correctly', () => {
    const patch = `*** Begin Patch
*** Add File: new.rs
+line1
+line2
+line3
*** Update File: old.rs
@@
 ctx
-old
+new
*** End Patch`;

    const result = parseApplyPatch(patch);
    expect(result).not.toBeNull();
    expect(result!.totalAdded).toBe(4);
    expect(result!.totalRemoved).toBe(1);
  });

  it('should count Add file lines correctly', () => {
    const patch = `*** Begin Patch
*** Add File: new.rs
+line1
+line2
+line3
*** End Patch`;

    const result = parseApplyPatch(patch);
    expect(result).not.toBeNull();
    expect(result!.totalAdded).toBe(3);
    expect(result!.files[0].addedLines).toBe(3);
    expect(result!.files[0].newContent).toBe('line1\nline2\nline3');
  });

  it('should skip empty lines after Begin Patch', () => {
    const patch = `*** Begin Patch

*** Add File: new.txt
+content
*** End Patch`;

    const result = parseApplyPatch(patch);
    expect(result).not.toBeNull();
    expect(result!.files[0]).toMatchObject({
      type: 'add',
      filePath: 'new.txt',
      newContent: 'content',
    });
  });

  it('should handle patch with only Delete operations', () => {
    const patch = `*** Begin Patch
*** Delete File: a.txt
*** Delete File: b.txt
*** End Patch`;

    const result = parseApplyPatch(patch);
    expect(result).not.toBeNull();
    expect(result!.totalFiles).toBe(2);
    expect(result!.totalAdded).toBe(0);
    expect(result!.totalRemoved).toBe(0);

    expect(result!.files[0].type).toBe('delete');
    expect(result!.files[1].type).toBe('delete');
  });

  it('should handle Add File with extra whitespace in path', () => {
    const patch = `*** Begin Patch
*** Add File:  src/new.rs
+hello
*** End Patch`;

    const result = parseApplyPatch(patch);
    expect(result).not.toBeNull();
    expect(result!.files[0].filePath).toBe('src/new.rs');
  });
});
