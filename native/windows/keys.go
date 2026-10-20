package main

// 按键和点击的判断（纯逻辑）：低级钩子把每个事件交给这里，这里说要不要吞掉、要往父进程报什么。
// 规矩照 macOS 版：
//   - 热键是单独一个修饰键，按下、松开各报一次；按住时又按了别的键，报一次 other_key（是组合键，不是听写）。
//     除了热键的按下松开，只报"有别的键"，不报是哪个键。
//   - 平时什么都不吞。听写进行中（父进程说"开始截"之后、"不截了"之前）吞掉 esc 和悬浮条那几块里的左键点击：
//     点击落到我们的窗口上会抢走焦点，esc 传给前台应用会顺手关掉它的对话框。
//   - 手还没松开的那一下要吞完整：按下吞了、松开却放出去的话，前台应用会收到没头没尾的半个事件。

// 虚拟键码（WinUser.h）
const (
	vkEscape   = 0x1B
	vkSpace    = 0x20
	vkLControl = 0xA2
	vkRControl = 0xA3
	vkRShift   = 0xA1
	vkRMenu    = 0xA5 // 右 Alt
	// 没有分配给任何键的键码。按住右 Alt 再松开，很多应用会把焦点交给菜单栏（Office 还会亮出按键提示）；
	// 按下热键时插一下这个键，系统就当成"Alt 加别的键"，松开时不再去开菜单。AutoHotkey 用的也是它
	vkMask = 0xE8
)

// 用了 AltGr 的键盘布局（德语等）上，按右 Alt 系统会先补一个假的左 Ctrl，扫描码是这个。它不是用户按的别的键
const altGrFakeCtrlScan = 0x21D

// 能选的热键：设置里的名字 → 虚拟键码。macOS 那几个（右 Option、右 Command、fn）在 Windows 上没有对应的键：
// 右 Win 松开会弹开始菜单，fn 系统根本看不到
var hotkeys = map[string]uint32{
	"right_alt":   vkRMenu,
	"right_ctrl":  vkRControl,
	"right_shift": vkRShift,
}

// 一个键盘事件
type keyInput struct {
	vk   uint32
	scan uint32
	down bool
	// 我们自己模拟的（插的 vkMask、贴字时的 Ctrl+V）：不算用户按的键，原样放行
	ours bool
}

type outcome struct {
	swallow bool
	events  []event
	// 要不要插一下 vkMask（见上）。不能在钩子里直接插：回到消息循环里再插
	mask bool
}

type keyState struct {
	hotkey        uint32
	hotkeyDown    bool
	reportedOther bool
	// 现在按着 Space 吗（组合键的另一半）。原版报的是"当前按住的全部键"，
	// 两键谁先落地都算组合；我们靠这个标志把"先按 Space 再按热键"也认成组合
	spaceDown bool
	// 这次按下的 Space 被我们吞了吗：吞了它的松开和自动重复也要吞完整，
	// 不然前台应用收到没头没尾的半个事件
	spaceSwallowed bool

	capturing bool
	regions   []region
	// 按下已经被吞掉、还在等松开的：esc，和鼠标（记着按在哪一块上，"" 是没有）
	escapeDown bool
	pressed    string
}

// 这个监听现在该不该吞东西：截着，或者被吞掉的那一下还没松开
func (s *keyState) wantsCapture() bool { return s.capturing || s.escapeDown || s.pressed != "" }

func (s *keyState) setCapturing(on bool, regions []region) {
	s.capturing = on
	if on {
		s.regions = regions
	} else {
		s.regions = nil
	}
}

func (s *keyState) regionAt(x, y float64) string {
	for _, r := range s.regions {
		if r.contains(x, y) {
			return r.ID
		}
	}
	return ""
}

func (s *keyState) onKey(in keyInput) outcome {
	if in.ours {
		return outcome{}
	}
	// 先看截不截：截下来的 esc 不再当成"热键加别的键"（macOS 上是两个监听，截的那个排在前面）
	if in.vk == vkEscape {
		if out, handled := s.onEscape(in.down); handled {
			return out
		}
	}
	if in.vk == s.hotkey {
		if in.down == s.hotkeyDown {
			// 按住时系统会一直补按下的事件（自动重复），不是新的一下
			return outcome{}
		}
		s.hotkeyDown = in.down
		s.reportedOther = false
		out := outcome{events: []event{{"event": "hotkey", "down": in.down}}, mask: in.down && s.hotkey == vkRMenu}
		// 组合键的另一半先落地了（两键同按，谁先谁后都算）：热键按下这一下就把组合报上去，
		// 状态机先收热键再收组合，正好走"开始录音 → 升级成指令"
		if in.down && s.spaceDown && s.hotkey != vkSpace {
			s.reportedOther = true
			out.events = append(out.events, event{"event": "other_key", "key": vkSpace})
		}
		return out
	}
	// 组合键的 Space：热键按住时按下的，整个吞掉（按下、自动重复、松开）。
	// 不吞的话系统会拼成 Alt+Space，弹出前台窗口的系统菜单（那个白框）——原版没有白框就是吞了。
	// 先按 Space 再按热键的那种不吞：按下已经到了前台应用，松开也得放出去，不然 Space 卡住
	if in.vk == vkSpace && s.hotkey != vkSpace {
		if in.down && s.hotkeyDown {
			s.spaceSwallowed = true
			s.spaceDown = true
			if !s.reportedOther {
				s.reportedOther = true
				return outcome{swallow: true, events: []event{{"event": "other_key", "key": in.vk}}}
			}
			return outcome{swallow: true}
		}
		if !in.down && s.spaceSwallowed {
			s.spaceSwallowed = false
			s.spaceDown = false
			return outcome{swallow: true}
		}
		s.spaceDown = in.down
	}
	if in.vk == vkLControl && in.scan == altGrFakeCtrlScan {
		return outcome{}
	}
	if in.down && s.hotkeyDown && !s.reportedOther {
		s.reportedOther = true
		// 带上键码：悬浮条用它识别"热键按住时按了 Space"的指令组合（对齐原版 askAnything 的 RightAlt+Space）
		return outcome{events: []event{{"event": "other_key", "key": in.vk}}}
	}
	return outcome{}
}

// esc：截着的时候吞掉并报一次；已经不截了、但取消用的那一下还没松开，它的重复和松开也吞掉
func (s *keyState) onEscape(down bool) (outcome, bool) {
	if down {
		if s.capturing {
			if s.escapeDown {
				return outcome{swallow: true}, true
			}
			s.escapeDown = true
			return outcome{swallow: true, events: []event{{"event": "escape"}}}, true
		}
		if s.escapeDown {
			return outcome{swallow: true}, true
		}
		return outcome{}, false
	}
	if s.escapeDown {
		s.escapeDown = false
		return outcome{swallow: true}, true
	}
	return outcome{}, false
}

// 鼠标左键。和普通按钮一样，按下和松开在同一块里才算点了它：按下之后拖出去再松手是反悔。
// 移动不吞：Windows 上吞了移动，光标就不动了；按下已经吞掉，别的应用看到的只是没按键的移动
func (s *keyState) onLeftButton(down bool, x, y float64) outcome {
	if down {
		if !s.capturing {
			return outcome{}
		}
		id := s.regionAt(x, y)
		if id == "" {
			return outcome{}
		}
		s.pressed = id
		return outcome{swallow: true}
	}
	if s.pressed == "" {
		return outcome{}
	}
	pressed := s.pressed
	s.pressed = ""
	if s.capturing && s.regionAt(x, y) == pressed {
		return outcome{swallow: true, events: []event{{"event": "click", "id": pressed}}}
	}
	return outcome{swallow: true}
}
