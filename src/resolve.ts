import {
  Ast,
  BUILTINS,
  Built,
  BuiltinName,
  Expr,
  Folder,
  Ident,
  Item,
  ItemId,
  LocalInfo,
  ModItem,
  Resolution,
  Resolved,
  mkDefaultFolder,
  superFoldExpr,
  superFoldItem,
  superFoldType,
} from "./ast";
import { CompilerError, spanMerge, todo } from "./error";
import { unwrap } from "./utils";

const BUILTIN_SET = new Set<string>(BUILTINS);

type Context = {
  ast: Ast<Built>;
  modContentsCache: Map<ItemId, Map<string, ItemId>>;
  newItemsById: Map<ItemId, Item<Resolved>>;
};

function resolveModItem(
  cx: Context,
  mod: ModItem<Built>,
  modId: ItemId,
  name: string
): ItemId | undefined {
  const cachedContents = cx.modContentsCache.get(modId);
  if (cachedContents) {
    return cachedContents.get(name);
  }

  switch (mod.modKind.kind) {
    case "inline": {
      const contents = new Map(
        mod.modKind.contents.map((item) => [item.node.name, item.id])
      );
      cx.modContentsCache.set(modId, contents);
      return contents.get(name);
    }
    case "extern": {
      todo("extern mod items");
    }
  }
}

export function resolve(ast: Ast<Built>): Ast<Resolved> {
  const cx: Context = {
    ast,
    modContentsCache: new Map(),
    newItemsById: new Map(),
  };

  const rootItems = resolveModule(cx, [ast.packageName], ast.rootItems);
  return {
    itemsById: cx.newItemsById,
    rootItems,
    packageName: ast.packageName,
  };
}

function resolveModule(
  cx: Context,
  modName: string[],
  contents: Item<Built>[]
): Item<Resolved>[] {
  const items = new Map<string, number>();

  contents.forEach((item) => {
    const existing = items.get(item.node.name);
    if (existing !== undefined) {
      throw new CompilerError(
        `item \`${item.node.name}\` has already been declared`,
        item.span
      );
    }
    items.set(item.node.name, item.id);
  });

  const scopes: string[] = [];

  const popScope = (expected: string) => {
    const popped = scopes.pop();
    if (popped !== expected) {
      throw new Error(
        `Scopes corrupted, wanted to pop ${expected} but popped ${popped}`
      );
    }
  };

  const resolveIdent = (ident: Ident): Resolution => {
    const lastIdx = scopes.length - 1;
    for (let i = lastIdx; i >= 0; i--) {
      const candidate = scopes[i];
      if (candidate === ident.name) {
        const index = lastIdx - i;
        return {
          kind: "local",
          index,
        };
      }
    }

    const item = items.get(ident.name);
    if (item !== undefined) {
      return {
        kind: "item",
        id: item,
      };
    }

    if (BUILTIN_SET.has(ident.name)) {
      return { kind: "builtin", name: ident.name as BuiltinName };
    }

    throw new CompilerError(`cannot find ${ident.name}`, ident.span);
  };

  const blockLocals: LocalInfo[][] = [];

  const resolver: Folder<Built, Resolved> = {
    ...mkDefaultFolder(),
    itemInner(item) {
      const defPath = [...modName, item.node.name];

      switch (item.kind) {
        case "function": {
          const params = item.node.params.map(({ name, span, type }) => ({
            name,
            span,
            type: this.type(type),
          }));
          const returnType =
            item.node.returnType && this.type(item.node.returnType);

          item.node.params.forEach(({ name }) => scopes.push(name));
          const body = this.expr(item.node.body);
          const revParams = item.node.params.slice();
          revParams.reverse();
          revParams.forEach(({ name }) => popScope(name));

          return {
            kind: "function",
            span: item.span,
            node: {
              name: item.node.name,
              params,
              returnType,
              body,
            },
            id: item.id,
            defPath,
          };
        }
        case "mod": {
          if (item.node.modKind.kind === "inline") {
            const contents = resolveModule(
              cx,
              defPath,
              item.node.modKind.contents
            );
            return {
              ...item,
              kind: "mod",
              node: { ...item.node, modKind: { kind: "inline", contents } },
              defPath,
            };
          }
          break;
        }
      }

      return { ...superFoldItem(item, this), defPath };
    },
    expr(expr) {
      switch (expr.kind) {
        case "block": {
          const prevScopeLength = scopes.length;
          blockLocals.push([]);

          const exprs = expr.exprs.map<Expr<Resolved>>((inner) =>
            this.expr(inner)
          );

          scopes.length = prevScopeLength;
          const locals = blockLocals.pop();

          return {
            kind: "block",
            exprs,
            locals,
            span: expr.span,
          };
        }
        case "let": {
          const rhs = this.expr(expr.rhs);
          const type = expr.type && this.type(expr.type);

          scopes.push(expr.name.name);
          const local = { name: expr.name.name, span: expr.name.span };
          blockLocals[blockLocals.length - 1].push(local);

          return {
            ...expr,
            name: expr.name,
            local,
            type,
            rhs,
          };
        }
        case "fieldAccess": {
          // We convert field accesses to paths if the lhs refers to a module.

          const lhs = this.expr(expr.lhs);

          if (lhs.kind === "ident" || lhs.kind === "path") {
            const res =
              lhs.kind === "ident" ? resolveIdent(lhs.value) : lhs.res;
            const segments =
              lhs.kind === "ident" ? [lhs.value.name] : lhs.segments;

            if (res.kind === "item") {
              const module = unwrap(cx.ast.itemsById.get(res.id));
              if (module.kind === "mod") {
                if (typeof expr.field.value === "number") {
                  throw new CompilerError(
                    "module contents cannot be indexed with a number",
                    expr.field.span
                  );
                }

                const pathResItem = resolveModItem(
                  cx,
                  module.node,
                  module.id,
                  expr.field.value
                );
                if (pathResItem === undefined) {
                  throw new CompilerError(
                    `module ${module.node.name} has no item ${expr.field.value}`,
                    expr.field.span
                  );
                }

                const pathRes: Resolution = { kind: "item", id: pathResItem };

                return {
                  kind: "path",
                  segments: [...segments, expr.field.value],
                  res: pathRes,
                  span: spanMerge(lhs.span, expr.field.span),
                };
              }
            }
          }

          return superFoldExpr(expr, this);
        }
        default: {
          return superFoldExpr(expr, this);
        }
      }
    },
    ident(ident) {
      const res = resolveIdent(ident);
      return { name: ident.name, span: ident.span, res };
    },
    type(type) {
      return superFoldType(type, this);
    },
    newItemsById: cx.newItemsById,
  };

  return contents.map((item) => resolver.item(item));
}
