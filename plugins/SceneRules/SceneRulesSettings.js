/**
 * SceneRulesSettings — full-page CRUD settings UI.
 *
 * Architecture:
 * - Registers a route via PluginApi.patch.before("PluginRoutes", ...) at
 *   /plugins/scenerules.
 * - Adds a launcher card in Settings > Tools via
 *   PluginApi.patch.before("SettingsToolsSection", ...).
 * - Reads/writes the same config key ("SceneRules") as the overlay.
 *   Semantic split: the settings page owns the rules array; the overlay owns
 *   the collapsed flag. Every save from this page reads the stored config to
 *   preserve collapsed.
 * - The overlay and settings page each have their own save lock. They do NOT
 *   coordinate across components, so a concurrent write from both could race
 *   (last writer wins the whole config map). This is considered demo-acceptable;
 *   settings edits will not live-reflect in an already-open overlay until the
 *   next page navigation or reload.
 */
(function () {
  "use strict";

  if (!window.PluginApi || !window.csLib) {
    console.error("SceneRules settings: PluginApi or csLib missing");
    return;
  }

  const React = PluginApi.React;
  const h = React.createElement;
  // PluginApi.React should expose hooks directly; fall back to React.useState etc.
  const { useState, useEffect, useRef } = React;
  const { Route, Link } = PluginApi.libraries.ReactRouterDOM;

  let saving = false;
  let pendingSave = false;
  let latestRules = null;

  function generateId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function saveRulesNow() {
    if (saving) {
      pendingSave = true;
      return;
    }
    saving = true;
    pendingSave = false;
    try {
      const rulesToSave = latestRules || [];
      const stored = csLib.getConfiguration("SceneRules") || {};
      const merged = {
        rules: rulesToSave,
        collapsed: typeof stored.collapsed === "boolean" ? stored.collapsed : true,
      };
      const result = csLib.setConfiguration("SceneRules", merged);

      function onDone() {
        saving = false;
        if (pendingSave) saveRulesNow();
      }

      if (result && typeof result.then === "function") {
        result
          .then(onDone)
          .catch(function (err) {
            console.error("SceneRules settings: save failed:", err);
            onDone();
          });
      } else {
        onDone();
      }
    } catch (err) {
      saving = false;
      console.error("SceneRules settings: save failed:", err);
      if (pendingSave) saveRulesNow();
    }
  }

  function saveRules(newRules) {
    latestRules = newRules;
    saveRulesNow();
  }

  function SceneRulesSettingsPage() {
    const [rules, setRules] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editingId, setEditingId] = useState(null);
    const [footerText, setFooterText] = useState("");
    const inputRef = useRef(null);
    // Live mirror of editingId so blur/Enter guards read the current value,
    // not a stale closure value from the render that attached the handler.
    const editingIdRef = useRef(null);

    useEffect(function () {
      let mounted = true;

      function finish(rulesArr) {
        if (!mounted) return;
        setRules(rulesArr);
        setLoading(false);
      }

      try {
        const result = csLib.getConfiguration("SceneRules");
        if (result && typeof result.then === "function") {
          result
            .then(function (stored) {
              finish(Array.isArray(stored && stored.rules) ? stored.rules : []);
            })
            .catch(function (err) {
              console.error("SceneRules settings: load failed:", err);
              finish([]);
            });
        } else {
          finish(Array.isArray(result && result.rules) ? result.rules : []);
        }
      } catch (err) {
        console.error("SceneRules settings: load failed:", err);
        finish([]);
      }

      return function () {
        mounted = false;
      };
    }, []);

    useEffect(function () {
      if (editingId && inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, [editingId]);

    // Keep the live ref in sync every render so blur/Enter guards see the
    // current editingId even after setEditingId(null) schedules a re-render.
    editingIdRef.current = editingId;

    function commitRules(nextRules) {
      setEditingId(null);
      setRules(nextRules);
      saveRules(nextRules);
    }

    function addRuleTop(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      const nextRules = [...rules, { id: generateId(), type: "rule", text: trimmed }];
      commitRules(nextRules);
    }

    function addCategoryTop(name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      const nextRules = [...rules, { id: generateId(), type: "category", name: trimmed, items: [] }];
      commitRules(nextRules);
    }

    function addRuleInto(categoryId, text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      const nextRules = rules.map(function (node) {
        if (node.type === "category" && node.id === categoryId) {
          return {
            ...node,
            items: [...(node.items || []), { id: generateId(), type: "rule", text: trimmed }],
          };
        }
        return node;
      });
      commitRules(nextRules);
    }

    function deleteRule(id) {
      const nextRules = [];
      for (const node of rules) {
        if (node.type === "rule" && node.id === id) continue;
        if (node.type === "category") {
          nextRules.push({
            ...node,
            items: (node.items || []).filter(function (r) {
              return r.id !== id;
            }),
          });
        } else {
          nextRules.push(node);
        }
      }
      commitRules(nextRules);
    }

    function deleteCategory(id) {
      const cat = rules.find(function (n) {
        return n.type === "category" && n.id === id;
      });
      if (!cat) return;
      const itemCount = Array.isArray(cat.items) ? cat.items.length : 0;
      const confirmed = window.confirm(
        'Delete category "' + cat.name + '" and its ' + itemCount + " rule(s)?"
      );
      if (!confirmed) return;
      const nextRules = rules.filter(function (n) {
        return !(n.type === "category" && n.id === id);
      });
      commitRules(nextRules);
    }

    function editNode(id, newText) {
      if (editingIdRef.current !== id) return;
      const trimmed = newText.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      const nextRules = rules.map(function (node) {
        if (node.id === id) {
          if (node.type === "category") {
            return { ...node, name: trimmed };
          }
          return { ...node, text: trimmed };
        }
        if (node.type === "category") {
          return {
            ...node,
            items: (node.items || []).map(function (item) {
              return item.id === id ? { ...item, text: trimmed } : item;
            }),
          };
        }
        return node;
      });
      setEditingId(null);
      setRules(nextRules);
      saveRules(nextRules);
    }

    function renderEditInput(node) {
      const currentValue = node.type === "category" ? node.name : node.text;
      return h("input", {
        ref: inputRef,
        className: "scene-rules-settings__edit-input",
        defaultValue: currentValue,
        onKeyDown: function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            editNode(node.id, e.target.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditingId(null);
          }
        },
        onBlur: function (e) {
          editNode(node.id, e.target.value);
        },
      });
    }

    function renderCategory(category) {
      return h(
        "div",
        { key: category.id, className: "scene-rules-settings__category" },
        h(
          "span",
          { className: "scene-rules-settings__category-name" },
          editingId === category.id
            ? renderEditInput(category)
            : h(
                "span",
                {
                  title: "Double-click to edit",
                  onDoubleClick: function () {
                    setEditingId(category.id);
                  },
                },
                category.name
              )
        ),
        h(
          "span",
          { className: "scene-rules-settings__controls" },
          h(
            "button",
            {
              title: "Add rule to this category",
              disabled: footerText.trim() === "",
              onClick: function () {
                addRuleInto(category.id, footerText);
                setFooterText("");
              },
            },
            "+"
          ),
          h(
            "button",
            {
              title: "Delete category",
              className: "scene-rules-settings__delete-btn",
              onClick: function () {
                deleteCategory(category.id);
              },
            },
            "×"
          )
        ),
        (category.items || []).map(function (rule) {
          return renderRule(rule, true);
        })
      );
    }

    function renderRule(rule, indented) {
      return h(
        "div",
        {
          key: rule.id,
          className:
            "scene-rules-settings__rule" +
            (indented ? " scene-rules-settings__rule--indented" : ""),
        },
        h(
          "span",
          { className: "scene-rules-settings__rule-text" },
          editingId === rule.id
            ? renderEditInput(rule)
            : h(
                "span",
                {
                  title: "Double-click to edit",
                  onDoubleClick: function () {
                    setEditingId(rule.id);
                  },
                },
                rule.text
              )
        ),
        h(
          "span",
          { className: "scene-rules-settings__controls" },
          h(
            "button",
            {
              title: "Delete rule",
              className: "scene-rules-settings__delete-btn",
              onClick: function () {
                deleteRule(rule.id);
              },
            },
            "×"
          )
        )
      );
    }

    const footerDisabled = footerText.trim() === "";

    return h(
      "div",
      { className: "scene-rules-settings" },
      h("h2", { className: "scene-rules-settings__header" }, "Scene Rules"),
      loading
        ? h("div", null, "Loading...")
        : h(
            "div",
            { className: "scene-rules-settings__list" },
            rules.length === 0
              ? h(
                  "div",
                  { className: "scene-rules-settings__empty" },
                  "No rules yet. Add a category or rule below."
                )
              : rules.map(function (node) {
                  return node.type === "category"
                    ? renderCategory(node)
                    : renderRule(node, false);
                }),
            h(
              "div",
              { className: "scene-rules-settings__footer" },
              h("input", {
                type: "text",
                className: "scene-rules-settings__input",
                value: footerText,
                placeholder: "New rule or category name",
                onChange: function (e) {
                  setFooterText(e.target.value);
                },
                onKeyDown: function (e) {
                  if (e.key === "Enter" && !footerDisabled) {
                    addRuleTop(footerText);
                    setFooterText("");
                  }
                },
              }),
              h(
                "button",
                {
                  disabled: footerDisabled,
                  onClick: function () {
                    addCategoryTop(footerText);
                    setFooterText("");
                  },
                },
                "Add Category"
              ),
              h(
                "button",
                {
                  disabled: footerDisabled,
                  onClick: function () {
                    addRuleTop(footerText);
                    setFooterText("");
                  },
                },
                "Add Rule"
              )
            )
          )
    );
  }

  PluginApi.patch.before("PluginRoutes", function (props) {
    const newChildren = h(
      React.Fragment,
      null,
      props.children,
      h(Route, { path: "/plugins/scenerules", component: SceneRulesSettingsPage })
    );
    return [Object.assign({}, props, { children: newChildren })];
  });

  PluginApi.patch.before("SettingsToolsSection", function (props) {
    const card = h(
      Link,
      { to: "/plugins/scenerules", className: "scene-rules-settings__launcher" },
      h(
        "div",
        { className: "scene-rules-settings__launcher-card" },
        h("h3", null, "Scene Rules"),
        h("p", null, "Manage viewing rules and categories")
      )
    );
    const newChildren = Array.isArray(props.children)
      ? [...props.children, card]
      : [props.children, card];
    return [Object.assign({}, props, { children: newChildren })];
  });
})();
