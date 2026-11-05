export type RepresentationKind = "text" | "tree";

export interface TextRep {
    kind: "text";
    tokens: string[];  // words or lines
}

export interface TreeRep {
  kind: "tree";
  root: TreeNode;
}

export type Representation = TextRep | TreeRep;

export interface TreeNode {
    tag: string;
    text?: string;
    attrs?: Record<string, string>;
    children: TreeNode[];
    path: string;  
}

export type EditType = "insert" | "delete" | "update" | "move";

export interface Edit {
    type: EditType;
    location?: string;  
    before?: string;
    after?: string;
}

// TODO: some interface for diffs themselves

export interface DiffResult {
    algorithm: string;
    diff:  {}
    stats: {
      sizeBytes: number;
    };
}