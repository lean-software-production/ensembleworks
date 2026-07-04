package protocol

import (
	"encoding/json"
	"testing"
)

func TestBinaryRoundTrip(t *testing.T) {
	frame := EncodeBinary(7, []byte("hello"))
	id, payload, ok := DecodeBinary(frame)
	if !ok || id != 7 || string(payload) != "hello" {
		t.Fatalf("round trip failed: ok=%v id=%d payload=%q", ok, id, payload)
	}
	if _, _, ok := DecodeBinary([]byte{0, 1}); ok {
		t.Fatal("short frame must not decode")
	}
}

func TestControlJSONWireNames(t *testing.T) {
	// Must parse exactly what the Node splicer sends.
	cases := []struct {
		raw  string
		want Control
	}{
		{`{"type":"relay-open","channelId":1,"sessionId":"s1","cols":80,"rows":24}`,
			Control{Type: "relay-open", ChannelID: 1, SessionID: "s1", Cols: 80, Rows: 24}},
		{`{"type":"relay-close","channelId":2}`, Control{Type: "relay-close", ChannelID: 2}},
		{`{"type":"relay-msg","channelId":3,"msg":{"type":"input","data":"ls\r"}}`,
			Control{Type: "relay-msg", ChannelID: 3, Msg: json.RawMessage(`{"type":"input","data":"ls\r"}`)}},
	}
	for _, c := range cases {
		var got Control
		if err := json.Unmarshal([]byte(c.raw), &got); err != nil {
			t.Fatalf("unmarshal %s: %v", c.raw, err)
		}
		if got.Type != c.want.Type || got.ChannelID != c.want.ChannelID ||
			got.SessionID != c.want.SessionID || got.Cols != c.want.Cols || got.Rows != c.want.Rows {
			t.Fatalf("got %+v want %+v", got, c.want)
		}
		if c.want.Msg != nil && string(got.Msg) != string(c.want.Msg) {
			t.Fatalf("msg: got %s want %s", got.Msg, c.want.Msg)
		}
	}
}

func TestInnerParse(t *testing.T) {
	var in Inner
	if err := json.Unmarshal([]byte(`{"type":"resize","cols":120,"rows":40}`), &in); err != nil {
		t.Fatal(err)
	}
	if in.Type != "resize" || in.Cols != 120 || in.Rows != 40 {
		t.Fatalf("got %+v", in)
	}
}

func TestWrapMsg(t *testing.T) {
	b, err := WrapMsg(5, Inner{Type: "attached", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"relay-msg","channelId":5,"msg":{"type":"attached","cols":80,"rows":24}}`
	if string(b) != want {
		t.Fatalf("got %s want %s", b, want)
	}
	if string(RelayClosed(9)) != `{"type":"relay-closed","channelId":9}` {
		t.Fatalf("relay-closed encoding wrong: %s", RelayClosed(9))
	}
}
