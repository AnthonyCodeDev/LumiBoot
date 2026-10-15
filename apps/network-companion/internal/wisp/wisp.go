// Package wisp implémente le cadrage binaire du protocole WISP V1 tel que
// parlé par le client embarqué dans v86@0.5.471.
//
// Format d'un paquet : [uint8 type][uint32 stream_id little-endian][payload...]
// Types : CONNECT (0x01), DATA (0x02), CONTINUE (0x03), CLOSE (0x04).
// INFO (0x05) appartient à WISP V2 et doit être ignoré.
//
// Rappel de compatibilité : le serveur DOIT envoyer, immédiatement après le
// handshake WebSocket, un CONTINUE de stream_id 0 portant la taille de buffer
// initiale. Sans lui, le client v86 bloque tout envoi (congestion non initialisée).
package wisp

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Types de paquets WISP V1.
const (
	TypeConnect  byte = 0x01
	TypeData     byte = 0x02
	TypeContinue byte = 0x03
	TypeClose    byte = 0x04
	// TypeInfo appartient à WISP V2 : le compagnon l'ignore.
	TypeInfo byte = 0x05
)

// Types de flux portés par CONNECT.
const (
	StreamTypeTCP byte = 0x01
	StreamTypeUDP byte = 0x02
)

// Raisons de fermeture envoyées par le client.
const (
	CloseClientDone  byte = 0x02 // fermeture volontaire
	CloseClientError byte = 0x03 // erreur réseau côté client
)

// Raisons de fermeture envoyées par le serveur.
const (
	CloseInvalidInfo        byte = 0x41 // demande invalide
	CloseHostUnreachable    byte = 0x42 // hôte injoignable
	CloseConnectTimeout     byte = 0x43 // timeout de connexion
	CloseConnectRefused     byte = 0x44 // connexion refusée
	CloseTransferTimeout    byte = 0x47 // timeout de transfert
	CloseDestinationBlocked byte = 0x48 // destination bloquée par la politique
	CloseThrottled          byte = 0x49 // limite de connexions atteinte
)

// HeaderLen est la taille fixe de l'en-tête d'un paquet WISP.
const HeaderLen = 5

// MaxHostLen borne la longueur d'un nom d'hôte dans CONNECT (RFC 1035 : 253).
const MaxHostLen = 253

var (
	// ErrFrameTooShort signale un paquet tronqué (moins de 5 octets).
	ErrFrameTooShort = errors.New("wisp: paquet tronqué")
	// ErrPayloadTooLarge signale un payload dépassant la limite configurée.
	ErrPayloadTooLarge = errors.New("wisp: payload trop grand")
	// ErrInvalidConnect signale un payload CONNECT malformé.
	ErrInvalidConnect = errors.New("wisp: CONNECT malformé")
	// ErrInvalidContinue signale un payload CONTINUE malformé.
	ErrInvalidContinue = errors.New("wisp: CONTINUE malformé")
	// ErrInvalidClose signale un payload CLOSE malformé.
	ErrInvalidClose = errors.New("wisp: CLOSE malformé")
)

// Frame est un paquet WISP décodé.
type Frame struct {
	Type     byte
	StreamID uint32
	Payload  []byte
}

// Encode sérialise le paquet au format fil.
func (f Frame) Encode() []byte {
	buf := make([]byte, HeaderLen+len(f.Payload))
	buf[0] = f.Type
	binary.LittleEndian.PutUint32(buf[1:5], f.StreamID)
	copy(buf[5:], f.Payload)
	return buf
}

// DecodeFrame décode un message WebSocket binaire complet en Frame.
// maxPayload borne la taille du payload accepté (protection mémoire).
func DecodeFrame(buf []byte, maxPayload int) (Frame, error) {
	if len(buf) < HeaderLen {
		return Frame{}, ErrFrameTooShort
	}
	payload := buf[HeaderLen:]
	if len(payload) > maxPayload {
		return Frame{}, fmt.Errorf("%w: %d octets (max %d)", ErrPayloadTooLarge, len(payload), maxPayload)
	}
	// Copie défensive : le tampon gorilla est réutilisé après lecture.
	cp := make([]byte, len(payload))
	copy(cp, payload)
	return Frame{
		Type:     buf[0],
		StreamID: binary.LittleEndian.Uint32(buf[1:5]),
		Payload:  cp,
	}, nil
}

// BuildContinue construit un paquet CONTINUE annonçant bufferRemaining
// paquets encore acceptés sur le flux streamID.
func BuildContinue(streamID uint32, bufferRemaining uint32) []byte {
	payload := make([]byte, 4)
	binary.LittleEndian.PutUint32(payload, bufferRemaining)
	return Frame{Type: TypeContinue, StreamID: streamID, Payload: payload}.Encode()
}

// BuildClose construit un paquet CLOSE portant la raison reason.
func BuildClose(streamID uint32, reason byte) []byte {
	return Frame{Type: TypeClose, StreamID: streamID, Payload: []byte{reason}}.Encode()
}

// BuildData construit un paquet DATA.
func BuildData(streamID uint32, data []byte) []byte {
	return Frame{Type: TypeData, StreamID: streamID, Payload: data}.Encode()
}

// ConnectRequest est un CONNECT décodé.
type ConnectRequest struct {
	StreamType byte
	Port       uint16
	Host       string
}

// ParseConnect décode le payload d'un CONNECT :
// [uint8 stream_type][uint16 port LE][hostname UTF-8 sans NUL].
func ParseConnect(payload []byte) (ConnectRequest, error) {
	if len(payload) < 3 {
		return ConnectRequest{}, ErrInvalidConnect
	}
	host := string(payload[3:])
	if len(host) == 0 || len(host) > MaxHostLen {
		return ConnectRequest{}, fmt.Errorf("%w: hôte de longueur invalide", ErrInvalidConnect)
	}
	for i := 0; i < len(host); i++ {
		if host[i] == 0 {
			return ConnectRequest{}, fmt.Errorf("%w: hôte contenant NUL", ErrInvalidConnect)
		}
	}
	return ConnectRequest{
		StreamType: payload[0],
		Port:       binary.LittleEndian.Uint16(payload[1:3]),
		Host:       host,
	}, nil
}

// BuildConnectPayload construit le payload d'un CONNECT (utile aux tests).
func BuildConnectPayload(streamType byte, port uint16, host string) []byte {
	payload := make([]byte, 3+len(host))
	payload[0] = streamType
	binary.LittleEndian.PutUint16(payload[1:3], port)
	copy(payload[3:], host)
	return payload
}

// ParseContinue décode le payload d'un CONTINUE (uint32 LE).
func ParseContinue(payload []byte) (uint32, error) {
	if len(payload) != 4 {
		return 0, ErrInvalidContinue
	}
	return binary.LittleEndian.Uint32(payload), nil
}

// ParseClose décode le payload d'un CLOSE (uint8 raison).
func ParseClose(payload []byte) (byte, error) {
	if len(payload) != 1 {
		return 0, ErrInvalidClose
	}
	return payload[0], nil
}
