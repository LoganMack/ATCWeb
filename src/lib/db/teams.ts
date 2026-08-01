import type { RestClient } from './client';
import type { Team } from './types';

const SELECT = 'id,name,status,primary_color_hex,logo_url';

export function teamsRepo(rest: RestClient) {
  return {
    /** All teams, active and inactive — the public Teams page splits them itself. */
    list() {
      return rest.get<Team[]>(`teams?select=${SELECT}&order=name.asc`);
    },

    async getById(id: string): Promise<Team | null> {
      const rows = await rest.get<Team[]>(`teams?select=${SELECT}&id=eq.${encodeURIComponent(id)}`);
      return rows[0] ?? null;
    },

    create(data: Partial<Team>) {
      return rest.post<Team>('teams', data);
    },

    update(id: string, data: Partial<Team>) {
      return rest.patch<Team>(`teams?id=eq.${encodeURIComponent(id)}`, data);
    },

    remove(id: string) {
      return rest.remove(`teams?id=eq.${encodeURIComponent(id)}`);
    },
  };
}
