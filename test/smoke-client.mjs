/**
 * 客户端 bundle 冒烟测试：模拟 window.__ModuleLoader__ 与 react，验证 apply() 注册了设置入口。
 *
 *   node test/smoke-client.mjs
 */

const registrations = [];
const injected = [];
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

let exported = null;

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const require = (request) => {
        if (request === "react") {
          // 客户端 bundle 里用了 class 错误边界，假 react 至少要提供一个可继承的 Component。
          class Component {
            constructor(props) {
              this.props = props || {};
              this.state = {};
            }

            setState(patch) {
              Object.assign(this.state, typeof patch === "function" ? patch(this.state) : patch);
            }
          }
          return {
            Component,
            createElement: (type, props, ...children) => ({ type, props, children }),
            useState: (initial) => [initial, () => {}],
            useEffect: () => {},
            useCallback: (fn) => fn,
            useMemo: (fn) => fn(),
            useRef: (value) => ({ current: value }),
          };
        }
        throw new Error(`客户端 bundle 只应依赖 react，实际请求：${request}`);
      };
      exported = factory(require);
      exported.__id = id;
    },
  },
};

await import("../lib/client.js");

expect(exported !== null, "bundle 未调用 window.__ModuleLoader__.load");
expect(exported?.__id === "dsh-wechat-clawbot", `bundle id 不正确：${exported?.__id}`);
expect(typeof exported?.apply === "function", "bundle 未导出 apply");
expect(Array.isArray(exported?.inject) && exported.inject.includes("slots"), "bundle inject 缺少 slots");

const ctx = {
  slots: {
    inject(name, factory) {
      injected.push(name);
      return factory();
    },
    register(registration, component) {
      registrations.push({ registration, component });
      return () => {};
    },
  },
};

exported.apply(ctx);

expect(injected.includes("settings.section"), "未 inject settings.section");
expect(injected.includes("settings.section.icon"), "未 inject settings.section.icon");
expect(registrations.length === 2, `注册数量应为 2，实际 ${registrations.length}`);
for (const item of registrations) {
  expect(item.registration?.name?.startsWith("settings.section"), `注册名异常：${item.registration?.name}`);
  expect(item.registration?.id === "wechat-clawbot", `注册 id 异常：${item.registration?.id}`);
  expect(typeof item.registration?.label === "function", "注册缺少 label 函数");
  expect(typeof item.component === "function", "注册缺少组件函数");
  expect(Number(item.registration?.order) > 0, "注册缺少 order");
}

// 组件函数本身不应在注册阶段抛错（不渲染，只检查是函数）
const sectionComponent = registrations.find((item) => item.registration.name === "settings.section")?.component;
expect(typeof sectionComponent === "function", "settings.section 组件不是函数");

// 设置页图标必须是内联 SVG，不能再是 emoji 文本
// 注册的组件是函数组件外层，假 createElement 不会替我们展开，这里手动展开一层。
const renderTree = (node) => {
  let current = node;
  for (let guard = 0; guard < 5 && current && typeof current.type === "function"; guard += 1) {
    current = current.type(current.props);
  }
  return current;
};

const iconComponent = registrations.find((item) => item.registration.name === "settings.section.icon")?.component;
expect(typeof iconComponent === "function", "settings.section.icon 组件不是函数");
const icon = renderTree(iconComponent({ size: 20 }));
expect(icon?.type === "svg", `图标根节点应为 svg，实际 ${typeof icon?.type}`);
expect(icon?.props?.width === 20 && icon?.props?.height === 20, "图标未按传入 size 缩放");
expect(icon?.props?.viewBox === "0 0 24 24", "图标缺少 viewBox");
expect(icon?.props?.["aria-label"] === "微信 ClawBot", "图标缺少 aria-label");
expect(icon?.props?.stroke === "currentColor", "图标描边未跟随 currentColor");

const textOf = (node) => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") return textOf(node.children);
  return "";
};
const iconText = textOf(icon);
expect(iconText === "", `图标不应包含文本节点，实际：${iconText}`);
expect(!/\p{Extended_Pictographic}/u.test(iconText), "图标里仍有 emoji 字符");

// 缺省 size 时要有可用的回退值，不能渲染成 0 宽
const iconDefault = renderTree(iconComponent());
expect(Number(iconDefault?.props?.width) > 0, "图标缺省宽度无效");

if (failures.length) {
  console.error("客户端冒烟测试失败：");
  for (const item of failures) console.error(` - ${item}`);
  process.exit(1);
}
console.log(`客户端冒烟测试通过：注册 ${registrations.length} 个设置槽位（${injected.join(", ")}）`);
