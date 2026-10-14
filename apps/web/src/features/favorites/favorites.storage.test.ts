import { describe, expect, it } from 'vitest';
import { FAVORITES_STORAGE_KEY, readFavorites, writeFavorites } from './favorites.storage';

describe('favorites.storage', () => {
  it('relit ce qui a été écrit', () => {
    expect(writeFavorites(['debian-12-i386', 'mint-x64'])).toBe(true);
    expect([...readFavorites()]).toEqual(['debian-12-i386', 'mint-x64']);
  });

  it('tolère un contenu corrompu', () => {
    localStorage.setItem(FAVORITES_STORAGE_KEY, '{not json');
    expect(readFavorites().size).toBe(0);
  });

  it('filtre les valeurs non textuelles', () => {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(['ok', 42, null]));
    expect([...readFavorites()]).toEqual(['ok']);
  });

  it('renvoie un ensemble vide sans stockage', () => {
    expect(readFavorites(null).size).toBe(0);
    expect(writeFavorites(['x'], null)).toBe(false);
  });
});
