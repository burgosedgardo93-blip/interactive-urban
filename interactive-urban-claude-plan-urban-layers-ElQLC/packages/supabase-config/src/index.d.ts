export type Bounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

export type YearRange = {
  from: number;
  to: number;
};

export type RecordResult = {
  id: string;
  year: number;
  title: string;
  category: string;
  desc: string;
  lat: number;
  lng: number;
  architect: string | null;
  demolished: number | null;
  img: string | null;
  source: string;
};

export type ContributionInput = {
  year: number;
  title: string;
  category: string;
  description?: string;
  lat: number;
  lng: number;
  architect?: string;
  demolished?: number | null;
  img_url?: string;
};

export declare function getSupabaseClient(): unknown;
export declare function fetchRecordsByBBox(bounds: Bounds, yearRange: YearRange): Promise<RecordResult[]>;
export declare function submitContribution(record: ContributionInput): Promise<{
  id: string;
  status: "pending";
  created_at: string;
}>;
export declare function fetchPendingContributions(): Promise<unknown[]>;
